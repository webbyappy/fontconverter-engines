// svg_table.cc -- see svg_table.h. P3b-11: the SVG table's glyph ids renumbered by a glyph map, in own code (HarfBuzz
// passes an SVG table through unchanged, so its documents would name the source's glyph ids).
//
// Each document (plain, or gzip, inflated to at most MAX_DOC_BYTES) is read as XML markup: comments, CDATA sections,
// processing instructions and the doctype are copied untouched; inside a tag every attribute value is examined. The
// supported references, rewritten all at once (so glyph1 <-> glyph2 swaps are safe):
//   id="glyphN" (the whole value), href / xlink:href="#glyphN" (the whole value), and url(#glyphN), url('#glyphN'),
//   url("#glyphN") inside any attribute value (style attributes included).
// Any other occurrence of glyph<digits> -- in text (a <style> element, a script), in another attribute or spelling,
// or written with character references (decoded before looking) -- is svg-unsupported-reference: never a partial
// rewrite. The index is rebuilt from the glyph elements each document defines: sorted, disjoint ranges, a document
// shared by several ranges where its new ids are not contiguous. A gzip document is written back gzip, level 9, with
// a fixed header (time 0, OS 255), so wasm and native builds give the same bytes.
#include "svg_table.h"

#include <zlib.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>

#include "names.h"

namespace hbf {

namespace {

const size_t MAX_DOC_BYTES = 64u * 1024 * 1024;  // bytes: one inflated document, far above any real colour font's

bool is_name_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' ||
         c == '.' || c == ':';
}

std::string inflate_gzip(const uint8_t* p, size_t n) {
  z_stream z = {};
  if (inflateInit2(&z, 16 + MAX_WBITS) != Z_OK) fail(Err::OutOfMemory, "zlib could not start inflating");
  std::string out;
  z.next_in = const_cast<Bytef*>(p);
  z.avail_in = (uInt)n;
  char buf[65536];
  int rc;
  do {
    z.next_out = (Bytef*)buf;
    z.avail_out = sizeof(buf);
    rc = inflate(&z, Z_NO_FLUSH);
    if (rc != Z_OK && rc != Z_STREAM_END) {
      inflateEnd(&z);
      fail(Err::SvgInvalid, "an SVG document's gzip data is damaged");
    }
    out.append(buf, sizeof(buf) - z.avail_out);
    if (out.size() > MAX_DOC_BYTES) {
      inflateEnd(&z);
      fail(Err::SvgInvalid, "an SVG document inflates past %zu MiB", MAX_DOC_BYTES >> 20);
    }
  } while (rc != Z_STREAM_END && (z.avail_in > 0 || z.avail_out == 0));
  inflateEnd(&z);
  if (rc != Z_STREAM_END) fail(Err::SvgInvalid, "an SVG document's gzip data ends early");
  return out;
}

Bytes deflate_gzip(const std::string& s) {
  z_stream z = {};
  if (deflateInit2(&z, 9, Z_DEFLATED, 16 + MAX_WBITS, 9, Z_DEFAULT_STRATEGY) != Z_OK) {
    fail(Err::OutOfMemory, "zlib could not start deflating");
  }
  gz_header h = {};
  h.os = 255;  // fixed: zlib's default is the build platform's code
  deflateSetHeader(&z, &h);
  Bytes out(deflateBound(&z, (uLong)s.size()) + 32);
  z.next_in = (Bytef*)const_cast<char*>(s.data());
  z.avail_in = (uInt)s.size();
  z.next_out = out.data();
  z.avail_out = (uInt)out.size();
  int rc = deflate(&z, Z_FINISH);
  deflateEnd(&z);
  if (rc != Z_STREAM_END) fail(Err::Internal, "zlib could not deflate an SVG document");
  out.resize(z.total_out);
  return out;
}

// Character references (any code point) and the five predefined entities decoded; *unknown set when another
// entity stays as written.
std::string decode_refs(const std::string& s, bool* unknown = nullptr) {
  std::string o;
  for (size_t i = 0; i < s.size();) {
    if (s[i] == '&') {
      size_t semi = s.find(';', i);
      if (semi != std::string::npos && semi - i <= 12) {
        std::string ent = s.substr(i + 1, semi - i - 1);
        long cp = -1;
        if (ent.size() > 1 && ent[0] == '#') {
          bool hex = ent[1] == 'x' || ent[1] == 'X';
          char* end = nullptr;
          cp = strtol(ent.c_str() + (hex ? 2 : 1), &end, hex ? 16 : 10);
          if (*end != '\0' || cp <= 0 || cp > 0x10ffff) cp = -1;
        } else if (ent == "amp") cp = '&';
        else if (ent == "lt") cp = '<';
        else if (ent == "gt") cp = '>';
        else if (ent == "quot") cp = '"';
        else if (ent == "apos") cp = '\'';
        if (cp > 0) {
          put_utf8(&o, (uint32_t)cp);
          i = semi + 1;
          continue;
        }
      }
      if (unknown) *unknown = true;
    }
    o += s[i++];
  }
  return o;
}

// A decoded attribute value written back inside `quote`.
std::string escape(const std::string& v, char quote) {
  std::string o;
  for (char c : v) {
    if (c == '&') o += "&amp;";
    else if (c == '<') o += "&lt;";
    else if (c == quote) o += quote == '"' ? "&quot;" : "&apos;";
    else o += c;
  }
  return o;
}

// Any glyph<digits> not preceded by a name character: a reference the rewrite did not take.
bool mentions_glyph(const std::string& raw) {
  std::string s = decode_refs(raw);
  for (size_t i = s.find("glyph"); i != std::string::npos; i = s.find("glyph", i + 1)) {
    if ((i == 0 || !is_name_char(s[i - 1])) && i + 5 < s.size() && s[i + 5] >= '0' && s[i + 5] <= '9') return true;
  }
  return false;
}

// "glyph<digits>" exactly: its number, or -1.
long glyph_number(const std::string& s) {
  if (s.size() < 6 || s.compare(0, 5, "glyph") != 0 || s.size() > 11) return -1;
  for (size_t i = 5; i < s.size(); ++i) {
    if (s[i] < '0' || s[i] > '9') return -1;
  }
  return strtol(s.c_str() + 5, nullptr, 10);
}

struct Rewriter {
  const std::vector<int>& map;
  std::vector<long> defined;  // the glyph ids this document's elements define (id="glyphN"), source numbering

  long renumber(long old) const {
    if (old < 0 || (size_t)old >= map.size() || map[old] < 0) {
      fail(Err::ColourGlyphUnmapped, "an SVG document names glyph %ld, which FontForge's output lacks", old);
    }
    return map[old];
  }

  // An attribute value rewritten (references decoded first): the whole value for id and href, url(#glyphN)
  // anywhere; the rest must not mention a glyph. A value that changes is written back escaped; one that does not
  // keeps its bytes.
  std::string value(const std::string& name, const std::string& raw, char quote) {
    bool unknown = false;
    std::string v = decode_refs(raw, &unknown);
    std::string out = rewrite(name, v);
    if (out == v) return raw;
    if (unknown) fail(Err::SvgUnsupportedReference, "an SVG attribute '%s' to rewrite holds an unknown entity", name.c_str());
    return escape(out, quote);
  }

  std::string rewrite(const std::string& name, const std::string& v) {
    long n = glyph_number(v);
    if (name == "id" && n >= 0) {
      defined.push_back(n);
      return "glyph" + std::to_string(renumber(n));
    }
    if ((name == "href" || name == "xlink:href") && v.size() > 1 && v[0] == '#' && (n = glyph_number(v.substr(1))) >= 0) {
      return "#glyph" + std::to_string(renumber(n));
    }
    std::string out, rest;
    size_t i = 0;
    while (i < v.size()) {
      size_t u = v.find("url(", i);
      if (u == std::string::npos) break;
      size_t close = v.find(')', u);
      if (close == std::string::npos) break;
      std::string inner = v.substr(u + 4, close - u - 4);
      char q = inner.size() >= 2 && (inner[0] == '\'' || inner[0] == '"') && inner.back() == inner[0] ? inner[0] : 0;
      std::string target = q ? inner.substr(1, inner.size() - 2) : inner;
      long g = target.size() > 1 && target[0] == '#' ? glyph_number(target.substr(1)) : -1;
      rest += v.substr(i, u - i);
      out += v.substr(i, u - i);
      if (g >= 0) {
        std::string t = "#glyph" + std::to_string(renumber(g));
        out += "url(" + (q ? std::string(1, q) + t + std::string(1, q) : t) + ")";
      } else {
        out += v.substr(u, close - u + 1);
        rest += v.substr(u, close - u + 1);
      }
      i = close + 1;
    }
    out += v.substr(i);
    rest += v.substr(i);
    if (mentions_glyph(rest)) fail(Err::SvgUnsupportedReference, "an SVG attribute '%s' names a glyph another way", name.c_str());
    return out;
  }

  std::string document(const std::string& d) {
    std::string out;
    size_t i = 0;
    while (i < d.size()) {
      size_t lt = d.find('<', i);
      std::string text = d.substr(i, lt == std::string::npos ? std::string::npos : lt - i);
      if (mentions_glyph(text)) fail(Err::SvgUnsupportedReference, "SVG text (a <style> or <script>, a timing value) names a glyph");
      out += text;
      if (lt == std::string::npos) break;
      static const struct {
        const char* open;
        const char* close;
      } kSkip[] = {{"<!--", "-->"}, {"<![CDATA[", "]]>"}, {"<?", "?>"}, {"<!", ">"}};
      bool skipped = false;
      for (const auto& k : kSkip) {
        if (d.compare(lt, strlen(k.open), k.open) == 0) {
          size_t end = d.find(k.close, lt + strlen(k.open));
          if (end == std::string::npos) fail(Err::SvgInvalid, "an SVG document ends inside markup");
          std::string inner = d.substr(lt, end + strlen(k.close) - lt);
          if (k.open[2] == '[' && mentions_glyph(inner)) {
            fail(Err::SvgUnsupportedReference, "an SVG CDATA section names a glyph");
          }
          if (strcmp(k.open, "<!") == 0 && (inner.find('[') != std::string::npos || inner.find("ENTITY") != std::string::npos)) {
            fail(Err::SvgUnsupportedReference, "an SVG document declares entities (an internal DTD subset)");
          }
          out += inner;
          i = end + strlen(k.close);
          skipped = true;
          break;
        }
      }
      if (skipped) continue;
      // A tag: its name, then attributes name = "value" or 'value', up to > or />.
      size_t p = lt + 1;
      while (p < d.size() && d[p] != '>' && d[p] != '/' && !isspace((unsigned char)d[p])) ++p;
      out += d.substr(lt, p - lt);
      for (;;) {
        size_t ws = p;
        while (p < d.size() && isspace((unsigned char)d[p])) ++p;
        out += d.substr(ws, p - ws);
        if (p >= d.size()) fail(Err::SvgInvalid, "an SVG document ends inside a tag");
        if (d[p] == '>' || d[p] == '/') {
          size_t gt = d.find('>', p);
          if (gt == std::string::npos) fail(Err::SvgInvalid, "an SVG document ends inside a tag");
          out += d.substr(p, gt + 1 - p);
          i = gt + 1;
          break;
        }
        size_t ns = p;
        while (p < d.size() && is_name_char(d[p])) ++p;
        std::string name = d.substr(ns, p - ns);
        if (name.empty()) fail(Err::SvgInvalid, "an SVG tag holds a stray character");
        size_t eq = p;
        while (p < d.size() && isspace((unsigned char)d[p])) ++p;
        if (p >= d.size() || d[p] != '=') fail(Err::SvgInvalid, "an SVG attribute without a value");
        ++p;
        while (p < d.size() && isspace((unsigned char)d[p])) ++p;
        if (p >= d.size() || (d[p] != '"' && d[p] != '\'')) fail(Err::SvgInvalid, "an SVG attribute value without quotes");
        char q = d[p];
        size_t vend = d.find(q, p + 1);
        if (vend == std::string::npos) fail(Err::SvgInvalid, "an SVG attribute value without its closing quote");
        out += d.substr(ns, p - ns + 1) + value(name, d.substr(p + 1, vend - p - 1), q) + q;
        (void)eq;
        p = vend + 1;
      }
    }
    return out;
  }
};

}  // namespace

Bytes svg_remap(const Bytes& table, const std::vector<int>& map) {
  if (table.size() < 10) fail(Err::SvgInvalid, "the SVG table is %zu bytes", table.size());
  uint32_t list = be32(table.data() + 2);
  if ((uint64_t)list + 2 > table.size()) fail(Err::SvgInvalid, "the SVG document list is outside the table");
  uint32_t n = be16(table.data() + list);
  if ((uint64_t)list + 2 + 12ull * n > table.size()) fail(Err::SvgInvalid, "the SVG document index runs past the table");
  struct Doc {
    std::string text;
    bool gzip;
    std::vector<std::pair<long, long>> ranges;  // the source's index ranges pointing at it
  };
  std::map<std::pair<uint32_t, uint32_t>, size_t> by_place;
  std::vector<Doc> docs;
  for (uint32_t i = 0; i < n; ++i) {
    const uint8_t* r = table.data() + list + 2 + 12 * i;
    uint32_t start = be16(r), end = be16(r + 2), off = be32(r + 4), len = be32(r + 8);
    if (start > end || (uint64_t)list + off + len > table.size() || len == 0) {
      fail(Err::SvgInvalid, "SVG index entry %u is damaged", i);
    }
    auto key = std::make_pair(off, len);
    auto it = by_place.find(key);
    if (it == by_place.end()) {
      const uint8_t* p = table.data() + list + off;
      bool gz = len >= 2 && p[0] == 0x1f && p[1] == 0x8b;
      Doc d = {gz ? inflate_gzip(p, len) : std::string((const char*)p, len), gz, {}};
      it = by_place.emplace(key, docs.size()).first;
      docs.push_back(d);
    }
    docs[it->second].ranges.push_back({start, end});
  }
  struct Entry {
    long start, end;
    size_t doc;
  };
  std::vector<Entry> entries;
  std::vector<Bytes> written(docs.size());
  for (size_t k = 0; k < docs.size(); ++k) {
    Rewriter rw = {map, {}};
    std::string text = rw.document(docs[k].text);
    written[k] = docs[k].gzip ? deflate_gzip(text) : Bytes(text.begin(), text.end());
    std::vector<long> ids;
    for (long g : rw.defined) {
      for (const auto& range : docs[k].ranges) {
        if (g >= range.first && g <= range.second) ids.push_back(map[g]);
      }
    }
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
    for (size_t a = 0; a < ids.size();) {
      size_t b = a;
      while (b + 1 < ids.size() && ids[b + 1] == ids[b] + 1) ++b;
      entries.push_back({ids[a], ids[b], k});
      a = b + 1;
    }
  }
  std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) { return a.start < b.start; });
  for (size_t i = 1; i < entries.size(); ++i) {
    if (entries[i].start <= entries[i - 1].end) fail(Err::SvgInvalid, "two SVG documents define glyph %ld", entries[i].start);
  }
  if (entries.size() > 0xffff) fail(Err::SvgInvalid, "%zu SVG index entries", entries.size());
  // Header (10 bytes), then the document list: count, entries, documents (each stored once).
  Bytes out(10, 0);
  out[5] = 10;  // offsetToSVGDocumentList = 10
  size_t list_at = out.size();
  size_t docs_at = 2 + 12 * entries.size();
  std::vector<uint32_t> doc_off(docs.size());
  uint64_t at = docs_at;
  for (size_t k = 0; k < docs.size(); ++k) {
    doc_off[k] = (uint32_t)at;
    at += written[k].size();
  }
  if (at > 0xffffffffull) fail(Err::SvgInvalid, "the SVG documents exceed 4 GiB");
  out.resize(list_at + docs_at);
  out[list_at] = (uint8_t)(entries.size() >> 8);
  out[list_at + 1] = (uint8_t)entries.size();
  for (size_t i = 0; i < entries.size(); ++i) {
    uint8_t* r = out.data() + list_at + 2 + 12 * i;
    const uint32_t v[] = {(uint32_t)entries[i].start, (uint32_t)entries[i].end, doc_off[entries[i].doc],
                          (uint32_t)written[entries[i].doc].size()};
    r[0] = (uint8_t)(v[0] >> 8);
    r[1] = (uint8_t)v[0];
    r[2] = (uint8_t)(v[1] >> 8);
    r[3] = (uint8_t)v[1];
    for (int k = 0; k < 4; ++k) {
      r[4 + k] = (uint8_t)(v[2] >> (24 - 8 * k));
      r[8 + k] = (uint8_t)(v[3] >> (24 - 8 * k));
    }
  }
  for (const Bytes& w : written) out.insert(out.end(), w.begin(), w.end());
  return out;
}

}  // namespace hbf
