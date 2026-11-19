// instance_names.cc -- see instance_names.h. The rule (P3b plan, section 3.4), as N4 pins it:
//   F = nameID 16, else 1 (trimmed).
//   S = the named instance's subfamily when every coordinate matches one (the first); else STAT: per design axis in
//       its axisOrdering, a format-4 value matching all its axes, else an exact nominal value (formats 1 to 3), else
//       the first format-2 range holding the coordinate (bounds included); elidable values left out, the elided
//       fallback name when all are; else, when STAT cannot name every axis, "<axis name> <value>" for each axis off
//       its default ("Regular" when none is).
//   1/2 = the legacy pair (only Bold and Italic style-linked: "Condensed Bold" -> "F Condensed" / "Bold");
//   4 = "F S" (F when S is Regular); 6 = the named instance's own PostScript name when valid, else a prefix (nameID 25
//   when it is 1 to 31 ASCII letters and digits, else F reduced to them, else "Font") then "-" + S reduced (a named
//   instance) or "_" + value + tag per axis off its default, capped at 63 with an FNV-1a suffix;
//   3 = "<fontRevision, 3 decimals>;<achVendID>;<6>".
#include "instance_names.h"

#include <algorithm>
#include <cstdio>
#include <map>

#include "info.h"
#include "names.h"
#include "sfnt.h"
#include "sfnt_edit.h"

namespace hbf {

namespace {

const uint16_t REWRITTEN[] = {1, 2, 3, 4, 6, 16, 17};

int32_t fixed_at(const uint8_t* p) { return (int32_t)be32(p); }

struct Axis {
  uint32_t tag;
  int32_t min, def, max;
  uint16_t name_id;
};
struct Named {
  uint16_t sub_id;
  int ps_id;  // -1: none
  std::vector<int32_t> coords;
};
struct Fvar {
  std::vector<Axis> axes;
  std::vector<Named> instances;
};

Fvar read_fvar(const Bytes& f, const Sfnt& s) {
  const Table* t = s.find(HBF_TAG('f', 'v', 'a', 'r'));
  if (!t || t->length < 16) fail(Err::SfntInvalid, "no readable fvar table");
  const uint8_t* b = f.data() + t->offset;
  uint32_t axes_at = be16(b + 4), n_axes = be16(b + 8), axis_size = be16(b + 10), n_inst = be16(b + 12),
           inst_size = be16(b + 14);
  if (axis_size < 20 || (uint64_t)axes_at + (uint64_t)n_axes * axis_size + (uint64_t)n_inst * inst_size > t->length ||
      inst_size < 4 + 4 * n_axes) {
    fail(Err::SfntInvalid, "the fvar table runs past its end");
  }
  Fvar v;
  for (uint32_t i = 0; i < n_axes; ++i) {
    const uint8_t* a = b + axes_at + i * axis_size;
    v.axes.push_back({be32(a), fixed_at(a + 4), fixed_at(a + 8), fixed_at(a + 12), be16(a + 18)});
  }
  for (uint32_t i = 0; i < n_inst; ++i) {
    const uint8_t* r = b + axes_at + n_axes * axis_size + i * inst_size;
    Named n = {be16(r), -1, {}};
    for (uint32_t k = 0; k < n_axes; ++k) n.coords.push_back(fixed_at(r + 4 + 4 * k));
    if (inst_size >= 6 + 4 * n_axes) {
      uint16_t ps = be16(r + 4 + 4 * n_axes);
      if (ps != 0xffff) n.ps_id = ps;
    }
    v.instances.push_back(n);
  }
  return v;
}

struct StatValue {
  int format;
  uint16_t flags, name_id;
  int axis;               // formats 1 to 3
  int32_t value, lo, hi;  // value: the nominal value; lo/hi: format 2's range
  std::vector<std::pair<int, int32_t>> multi;  // format 4
};
struct Stat {
  bool ok = false;
  std::vector<uint32_t> tags;
  std::vector<uint16_t> ordering;
  std::vector<StatValue> values;
  uint16_t elided = 2;
};

// STAT as a naming source; a missing or malformed table gives ok = false (the names then come from fvar's axes).
Stat read_stat(const Bytes& f, const Sfnt& s) {
  Stat st;
  const Table* t = s.find(HBF_TAG('S', 'T', 'A', 'T'));
  if (!t || t->length < 18) return st;
  const uint8_t* b = f.data() + t->offset;
  const uint64_t len = t->length;
  uint32_t minor = be16(b + 2), axis_size = be16(b + 4), n_axes = be16(b + 6), axes_at = be32(b + 8),
           n_values = be16(b + 12), values_at = be32(b + 14);
  if (minor >= 1 && len >= 20) st.elided = be16(b + 18);
  if (axis_size < 8 || (uint64_t)axes_at + (uint64_t)n_axes * axis_size > len || (uint64_t)values_at + 2ull * n_values > len) {
    return st;
  }
  for (uint32_t i = 0; i < n_axes; ++i) {
    st.tags.push_back(be32(b + axes_at + i * axis_size));
    st.ordering.push_back(be16(b + axes_at + i * axis_size + 6));
  }
  for (uint32_t i = 0; i < n_values; ++i) {
    uint64_t at = (uint64_t)values_at + be16(b + values_at + 2 * i);
    if (at + 12 > len) return Stat();
    const uint8_t* v = b + at;
    StatValue x = {be16(v), 0, 0, -1, 0, 0, 0, {}};
    if (x.format >= 1 && x.format <= 3) {
      uint64_t need = x.format == 2 ? 20 : x.format == 3 ? 16 : 12;
      if (at + need > len) return Stat();
      x.axis = be16(v + 2);
      x.flags = be16(v + 4);
      x.name_id = be16(v + 6);
      x.value = fixed_at(v + 8);
      if (x.format == 2) {
        x.lo = fixed_at(v + 12);
        x.hi = fixed_at(v + 16);
      }
      if ((uint32_t)x.axis >= n_axes) return Stat();
    } else if (x.format == 4) {
      uint32_t count = be16(v + 2);
      x.flags = be16(v + 4);
      x.name_id = be16(v + 6);
      if (at + 8 + 6ull * count > len || count == 0) return Stat();
      for (uint32_t k = 0; k < count; ++k) {
        uint32_t ax = be16(v + 8 + 6 * k);
        if (ax >= n_axes) return Stat();
        x.multi.push_back({(int)ax, fixed_at(v + 10 + 6 * k)});
      }
    } else {
      continue;  // a format this rule does not read
    }
    st.values.push_back(x);
  }
  st.ok = true;
  return st;
}

std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

std::string reduce(const std::string& s) {
  std::string o;
  for (char c : s) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) o += c;
  }
  return o;
}

bool valid_postscript(const std::string& s) {
  if (s.empty() || s.size() > 63) return false;
  for (char c : s) {
    if (c < 33 || c > 126 || std::string("[](){}<>/%").find(c) != std::string::npos) return false;
  }
  return true;
}

bool valid_prefix(const std::string& s) { return !s.empty() && s.size() <= 31 && reduce(s) == s; }

std::string tag_text(uint32_t tag) {
  std::string s;
  for (int i = 0; i < 4; ++i) {
    char c = (char)(tag >> (24 - 8 * i));
    if (c != ' ') s += c;
  }
  return s;
}

std::string english(const Bytes& f, const Sfnt& s, uint16_t id) {
  std::string n;
  return english_name(f, s, id, &n) ? trim(n) : "";
}

// S from STAT, or "" when STAT cannot name every axis.
std::string stat_subfamily(const Bytes& f, const Sfnt& s, const Stat& st, const Fvar& fv, const std::vector<Pin>& pins) {
  if (!st.ok) return "";
  auto pin_of = [&](uint32_t tag, int32_t* v) {
    for (const Pin& p : pins) {
      if (p.tag == tag) {
        *v = p.fixed;
        return true;
      }
    }
    return false;
  };
  for (size_t i = 0; i < fv.axes.size(); ++i) {  // an fvar axis STAT does not know must sit at its default
    if (std::find(st.tags.begin(), st.tags.end(), fv.axes[i].tag) == st.tags.end() && pins[i].fixed != fv.axes[i].def) {
      return "";
    }
  }
  std::vector<size_t> order(st.tags.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return st.ordering[a] < st.ordering[b]; });
  std::vector<const StatValue*> four;
  for (const StatValue& v : st.values) {
    if (v.format == 4) four.push_back(&v);
  }
  std::stable_sort(four.begin(), four.end(), [](const StatValue* a, const StatValue* b) { return a->multi.size() > b->multi.size(); });
  std::vector<bool> covered(st.tags.size(), false);
  std::vector<std::string> parts;
  for (size_t i : order) {
    int32_t c;
    if (covered[i] || !pin_of(st.tags[i], &c)) continue;
    const StatValue* hit = nullptr;
    for (const StatValue* v : four) {
      bool has = false, all = true;
      for (const auto& m : v->multi) {
        int32_t mc;
        has = has || (size_t)m.first == i;
        all = all && !covered[m.first] && pin_of(st.tags[m.first], &mc) && mc == m.second;
      }
      if (has && all) {
        hit = v;
        for (const auto& m : v->multi) covered[m.first] = true;
        break;
      }
    }
    for (const StatValue& v : st.values) {
      if (!hit && v.format != 4 && (size_t)v.axis == i && v.value == c) hit = &v;
    }
    for (const StatValue& v : st.values) {
      if (!hit && v.format == 2 && (size_t)v.axis == i && v.lo <= c && c <= v.hi) hit = &v;
    }
    if (!hit) return "";
    covered[i] = true;
    std::string name = english(f, s, hit->name_id);
    if (name.empty()) return "";
    if (!(hit->flags & 0x0002)) parts.push_back(name);
  }
  std::string out;
  for (const std::string& p : parts) out += (out.empty() ? "" : " ") + p;
  if (out.empty()) out = english(f, s, st.elided);
  return out.empty() ? "Regular" : out;
}

struct Legacy {
  std::string family, style;
  bool bold = false, italic = false;
};

Legacy legacy(const std::string& family, const std::string& sub) {
  Legacy l;
  std::string rest;
  size_t at = 0;
  while (at < sub.size()) {
    size_t sp = sub.find(' ', at);
    std::string w = sub.substr(at, sp == std::string::npos ? std::string::npos : sp - at);
    if (w == "Bold") l.bold = true;
    else if (w == "Italic") l.italic = true;
    else if (!w.empty() && w != "Regular") rest += (rest.empty() ? "" : " ") + w;
    if (sp == std::string::npos) break;
    at = sp + 1;
  }
  l.family = rest.empty() ? family : family + " " + rest;
  l.style = l.bold && l.italic ? "Bold Italic" : l.bold ? "Bold" : l.italic ? "Italic" : "Regular";
  return l;
}

uint32_t fnv1a(const std::string& s) {
  uint32_t h = 0x811c9dc5u;
  for (unsigned char c : s) {
    h ^= c;
    h *= 0x01000193u;
  }
  return h;
}

std::string text_of(const NameTable& t, uint16_t platform, uint16_t encoding, uint16_t language, uint16_t id) {
  for (const NameRecord& r : t.records) {
    std::string s;
    if (r.platform == platform && r.encoding == encoding && r.language == language && r.id == id && record_text(r, &s)) {
      return trim(s);
    }
  }
  return "";
}

}  // namespace

InstanceNames instance_names(const Bytes& source, const Bytes& instance, const std::vector<Pin>& pins) {
  Sfnt s = parse_sfnt(source);
  Fvar fv = read_fvar(source, s);
  if (pins.size() != fv.axes.size()) fail(Err::Internal, "%zu pins for %zu axes", pins.size(), fv.axes.size());
  InstanceNames n;
  n.family = english(source, s, 16);
  if (n.family.empty()) n.family = english(source, s, 1);
  if (n.family.empty()) n.family = "Font";
  for (size_t i = 0; i < fv.instances.size() && n.named < 0; ++i) {
    bool all = true;
    for (size_t k = 0; k < fv.axes.size(); ++k) all = all && fv.instances[i].coords[k] == pins[k].fixed;
    if (all) n.named = (int)i;
  }
  if (n.named >= 0) n.subfamily = english(source, s, fv.instances[n.named].sub_id);
  if (n.subfamily.empty()) n.subfamily = stat_subfamily(source, s, read_stat(source, s), fv, pins);
  if (n.subfamily.empty()) {
    for (size_t k = 0; k < fv.axes.size(); ++k) {
      if (pins[k].fixed == fv.axes[k].def) continue;
      std::string name = english(source, s, fv.axes[k].name_id);
      if (name.empty()) name = tag_text(fv.axes[k].tag);
      n.subfamily += (n.subfamily.empty() ? "" : " ") + name + " " + fixed_str(pins[k].fixed / 65536.0);
    }
    if (n.subfamily.empty()) n.subfamily = "Regular";
  }
  Legacy l = legacy(n.family, n.subfamily);
  n.legacy_family = l.family;
  n.legacy_style = l.style;
  n.bold = l.bold;
  n.italic = l.italic;
  n.full = n.subfamily == "Regular" ? n.family : n.family + " " + n.subfamily;
  bool has_ital = false;
  for (size_t k = 0; k < fv.axes.size(); ++k) has_ital = has_ital || fv.axes[k].tag == HBF_TAG('i', 't', 'a', 'l');
  for (size_t k = 0; k < fv.axes.size(); ++k) {
    if (fv.axes[k].tag == HBF_TAG('s', 'l', 'n', 't') && pins[k].fixed != 0 && !has_ital) n.oblique = true;
  }

  std::string own = n.named >= 0 && fv.instances[n.named].ps_id >= 0
                        ? english(source, s, (uint16_t)fv.instances[n.named].ps_id) : "";
  if (valid_postscript(own)) {
    n.postscript = own;
  } else {
    std::string prefix = english(source, s, 25);
    if (!valid_prefix(prefix)) prefix = reduce(n.family);
    if (prefix.empty()) prefix = "Font";
    std::string ps = prefix;
    if (n.named >= 0) {
      std::string r = reduce(n.subfamily);
      if (!r.empty()) ps += "-" + r;
    } else {
      for (size_t k = 0; k < fv.axes.size(); ++k) {
        if (pins[k].fixed != fv.axes[k].def) ps += "_" + fixed_str(pins[k].fixed / 65536.0) + tag_text(fv.axes[k].tag);
      }
    }
    if (ps.size() > 63) {
      char hash[16];
      snprintf(hash, sizeof(hash), "-%08X", fnv1a(ps));
      ps = ps.substr(0, 54) + hash;
    }
    n.postscript = ps;
  }

  Sfnt si = parse_sfnt(instance);
  const Table* head = si.find(HBF_TAG('h', 'e', 'a', 'd'));
  if (!head || head->length < 54) fail(Err::OutputInvalid, "the instance has no head table");
  char rev[32];
  snprintf(rev, sizeof(rev), "%.3f", fixed_at(instance.data() + head->offset + 4) / 65536.0);
  std::string vendor;
  const Table* os2 = si.find(HBF_TAG('O', 'S', '/', '2'));
  if (os2 && os2->length >= 62) {
    for (int i = 0; i < 4; ++i) {
      char c = (char)instance[os2->offset + 58 + i];
      if (c >= 0x20 && c <= 0x7e) vendor += c;
    }
    vendor = trim(vendor);
  }
  n.unique = std::string(rev) + ";" + vendor + ";" + n.postscript;
  return n;
}

Bytes apply_instance_names(const Bytes& source, const Bytes& instance, const InstanceNames& n) {
  Sfnt s = parse_sfnt(source);
  Fvar fv = read_fvar(source, s);
  Sfnt si = parse_sfnt(instance);
  NameTable t = read_name_table(instance, si);
  bool mac = false;
  int unicode_encoding = -1;
  std::vector<uint16_t> languages;  // other Windows languages of nameID 1 or 16
  for (const NameRecord& r : t.records) {
    bool family = r.id == 1 || r.id == 2 || r.id == 16 || r.id == 17;
    if (family && r.platform == 1 && r.encoding == 0 && r.language == 0) mac = true;
    if (family && r.platform == 0 && unicode_encoding < 0) unicode_encoding = r.encoding;
    if ((r.id == 1 || r.id == 16) && r.platform == 3 && r.encoding == 1 && r.language != 0x409 &&
        std::find(languages.begin(), languages.end(), r.language) == languages.end()) {
      languages.push_back(r.language);
    }
  }
  struct Local {
    uint16_t language;
    std::string family, sub;
  };
  std::vector<Local> locals;
  for (uint16_t lang : languages) {
    std::string f = text_of(t, 3, 1, lang, 16);
    if (f.empty()) f = text_of(t, 3, 1, lang, 1);
    std::string sub = n.named >= 0 ? text_of(t, 3, 1, lang, fv.instances[n.named].sub_id) : "";
    locals.push_back({lang, f, sub.empty() ? n.subfamily : sub});
  }
  t.records.erase(std::remove_if(t.records.begin(), t.records.end(), [](const NameRecord& r) {
                    return std::find(std::begin(REWRITTEN), std::end(REWRITTEN), r.id) != std::end(REWRITTEN);
                  }),
                  t.records.end());
  std::map<uint16_t, std::string> english_names = {{1, n.legacy_family}, {2, n.legacy_style}, {3, n.unique},
                                                   {4, n.full},          {6, n.postscript},   {16, n.family},
                                                   {17, n.subfamily}};
  for (const auto& e : english_names) {
    t.records.push_back({3, 1, 0x409, e.first, utf16be(e.second)});
    Bytes m;
    if (mac && mac_roman(e.second, &m)) t.records.push_back({1, 0, 0, e.first, m});
    if (unicode_encoding >= 0) t.records.push_back({0, (uint16_t)unicode_encoding, 0, e.first, utf16be(e.second)});
  }
  for (const Local& l : locals) {
    Legacy lg = legacy(l.family, l.sub);
    std::map<uint16_t, std::string> local = {{1, lg.family}, {2, lg.style}, {16, l.family}, {17, l.sub},
                                             {4, l.sub == "Regular" ? l.family : l.family + " " + l.sub}};
    for (const auto& e : local) t.records.push_back({3, 1, l.language, e.first, utf16be(e.second)});
  }

  std::map<uint32_t, Bytes> replace;
  replace[HBF_TAG('n', 'a', 'm', 'e')] = write_name_table(t);
  const Table* os2 = si.find(HBF_TAG('O', 'S', '/', '2'));
  if (os2 && os2->length >= 64) {
    Bytes o(instance.begin() + os2->offset, instance.begin() + os2->offset + os2->length);
    uint16_t fs = be16(o.data() + 62) & (uint16_t)~(0x0001 | 0x0020 | 0x0040 | 0x0200);
    if (n.bold) fs |= 0x0020;
    if (n.italic) fs |= 0x0001;
    if (!n.bold && !n.italic) fs |= 0x0040;
    if (n.oblique && be16(o.data()) >= 4) fs |= 0x0200;
    o[62] = (uint8_t)(fs >> 8);
    o[63] = (uint8_t)fs;
    replace[HBF_TAG('O', 'S', '/', '2')] = o;
  }
  const Table* head = si.find(HBF_TAG('h', 'e', 'a', 'd'));
  if (!head || head->length < 54) fail(Err::OutputInvalid, "the instance has no head table");
  Bytes h(instance.begin() + head->offset, instance.begin() + head->offset + head->length);
  uint16_t mac_style = be16(h.data() + 44) & (uint16_t)~0x0003;
  if (n.bold) mac_style |= 0x0001;
  if (n.italic) mac_style |= 0x0002;
  h[44] = (uint8_t)(mac_style >> 8);
  h[45] = (uint8_t)mac_style;
  replace[HBF_TAG('h', 'e', 'a', 'd')] = h;
  return replace_tables(instance, replace);
}

}  // namespace hbf
