// cff.cc -- see cff.h.
#include "cff.h"

#include <algorithm>

namespace hbf {

CffIndex cff_read_index(const Bytes& c, size_t at) {
  CffIndex x;
  x.start = at;
  if (at + 2 > c.size()) fail(Err::CffInvalid, "a CFF INDEX runs past the table");
  x.count = be16(c.data() + at);
  if (x.count == 0) {
    x.end = at + 2;
    x.item_start.push_back(at + 2);
    return x;
  }
  if (at + 3 > c.size()) fail(Err::CffInvalid, "a CFF INDEX runs past the table");
  uint32_t off_size = c[at + 2];
  if (off_size < 1 || off_size > 4) fail(Err::CffInvalid, "a CFF INDEX has offSize %u", off_size);
  size_t offsets = at + 3, data = offsets + (size_t)(x.count + 1) * off_size - 1;
  if (offsets + (size_t)(x.count + 1) * off_size > c.size()) fail(Err::CffInvalid, "a CFF INDEX runs past the table");
  for (uint32_t i = 0; i <= x.count; ++i) {
    uint32_t v = 0;
    for (uint32_t k = 0; k < off_size; ++k) v = (v << 8) | c[offsets + i * off_size + k];
    if (v < 1 || (uint64_t)data + v > c.size()) fail(Err::CffInvalid, "a CFF INDEX offset points past the table");
    x.item_start.push_back(data + v);
  }
  x.end = x.item_start.back();
  return x;
}

std::vector<CffDictEntry> cff_read_dict(const Bytes& c, size_t from, size_t to) {
  std::vector<CffDictEntry> out;
  std::vector<CffOperand> stack;
  size_t p = from, entry = from;
  while (p < to) {
    uint8_t b0 = c[p];
    if (b0 <= 21) {
      int op = b0;
      ++p;
      if (b0 == 12) {
        if (p >= to) fail(Err::CffInvalid, "a CFF DICT ends inside an operator");
        op = 1200 + c[p++];
      }
      out.push_back({op, stack, entry, p});
      entry = p;
      stack.clear();
    } else if (b0 == 28) {
      if (p + 3 > to) fail(Err::CffInvalid, "a CFF DICT ends inside an operand");
      stack.push_back({p, 28, (int16_t)be16(c.data() + p + 1)});
      p += 3;
    } else if (b0 == 29) {
      if (p + 5 > to) fail(Err::CffInvalid, "a CFF DICT ends inside an operand");
      stack.push_back({p, 29, (int32_t)be32(c.data() + p + 1)});
      p += 5;
    } else if (b0 == 30) {
      size_t q = p + 1;
      while (q < to && (c[q] & 0x0f) != 0x0f && (c[q] >> 4) != 0x0f) ++q;
      if (q >= to) fail(Err::CffInvalid, "a CFF DICT ends inside a real number");
      stack.push_back({p, 30, 0});
      p = q + 1;
    } else if (b0 >= 32 && b0 <= 246) {
      stack.push_back({p, 1, (int64_t)b0 - 139});
      p += 1;
    } else if (b0 >= 247 && b0 <= 254) {
      if (p + 2 > to) fail(Err::CffInvalid, "a CFF DICT ends inside an operand");
      int64_t v = b0 <= 250 ? (b0 - 247) * 256 + c[p + 1] + 108 : -(b0 - 251) * 256 - c[p + 1] - 108;
      stack.push_back({p, 2, v});
      p += 2;
    } else {
      fail(Err::CffInvalid, "a CFF DICT holds the reserved byte %u", b0);
    }
  }
  return out;
}

std::vector<CffDictEntry> cff_top_dict(const Bytes& c, size_t* names_end) {
  if (c.size() < 4) fail(Err::CffInvalid, "the CFF table is %zu bytes", c.size());
  if (c[0] != 1) fail(Err::CffInvalid, "CFF major version %u", c[0]);
  CffIndex names = cff_read_index(c, c[2]);
  if (names.count != 1) fail(Err::CffLayoutUnsupported, "the CFF Name INDEX holds %u names", names.count);
  CffIndex top = cff_read_index(c, names.end);
  if (top.count != 1) fail(Err::CffLayoutUnsupported, "the CFF Top DICT INDEX holds %u DICTs", top.count);
  if (names_end) *names_end = names.end;
  return cff_read_dict(c, top.item_start[0], top.item_start[1]);
}

std::vector<uint32_t> cff_glyph_cids(const Bytes& c, uint32_t num_glyphs) {
  std::vector<CffDictEntry> top = cff_top_dict(c);
  bool cid = false;
  int64_t charset = 0;
  for (const CffDictEntry& e : top) {
    if (e.op == 1230) cid = true;  // ROS
    if (e.op == 15 && !e.operands.empty()) charset = e.operands.back().value;
  }
  if (!cid) return {};
  if (charset <= 2) fail(Err::CffInvalid, "a CID-keyed CFF with the predefined charset %lld", (long long)charset);
  if ((uint64_t)charset >= c.size()) fail(Err::CffInvalid, "the CFF charset offset points past the table");
  std::vector<uint32_t> cids(num_glyphs, 0);
  size_t p = (size_t)charset;
  uint8_t format = c[p++];
  uint32_t g = 1;
  auto need = [&](size_t n) {
    if (p + n > c.size()) fail(Err::CffInvalid, "the CFF charset runs past the table");
  };
  if (format == 0) {
    for (; g < num_glyphs; ++g) {
      need(2);
      cids[g] = be16(c.data() + p);
      p += 2;
    }
  } else if (format == 1 || format == 2) {
    while (g < num_glyphs) {
      need(format == 1 ? 3 : 4);
      uint32_t first = be16(c.data() + p);
      uint32_t left = format == 1 ? c[p + 2] : be16(c.data() + p + 2);
      p += format == 1 ? 3 : 4;
      for (uint32_t k = 0; k <= left && g < num_glyphs; ++k) cids[g++] = first + k;
    }
  } else {
    fail(Err::CffInvalid, "CFF charset format %u", format);
  }
  return cids;
}

size_t cff1_check_stack(const Bytes& c) {
  const size_t kMaxStack = 48;  // Type 2 charstrings in CFF (CFF2 allows 513)
  std::vector<CffDictEntry> top = cff_top_dict(c);
  int64_t cs_at = 0;
  for (const CffDictEntry& e : top) {
    if (e.op == 17 && !e.operands.empty()) cs_at = e.operands.back().value;
  }
  if (cs_at <= 0 || (uint64_t)cs_at >= c.size()) fail(Err::CffInvalid, "the CFF has no CharStrings INDEX");
  CffIndex names = cff_read_index(c, c[2]);
  CffIndex tops = cff_read_index(c, names.end);
  CffIndex strings = cff_read_index(c, tops.end);
  CffIndex gsubrs = cff_read_index(c, strings.end);
  if (gsubrs.count) fail(Err::OutputInvalid, "the downgraded CFF has %u global subroutines", gsubrs.count);
  CffIndex cs = cff_read_index(c, (size_t)cs_at);
  size_t deepest = 0;
  for (uint32_t g = 0; g < cs.count; ++g) {
    size_t p = cs.item_start[g], end = cs.item_start[g + 1], depth = 0, stems = 0;
    while (p < end) {
      uint8_t b = c[p];
      if (b == 28 || b >= 32) {  // an operand: 3 bytes, 1, 2 or a 5-byte fixed
        ++depth;
        p += b == 28 ? 3 : b <= 246 ? 1 : b <= 254 ? 2 : 5;
        continue;
      }
      deepest = std::max(deepest, depth);
      if (b == 10 || b == 29) fail(Err::OutputInvalid, "glyph %u of the downgraded CFF calls a subroutine", g);
      if (b == 1 || b == 3 || b == 18 || b == 23) stems += depth / 2;  // [hv]stem[hm]: pairs (an odd one is the width)
      if (b == 19 || b == 20) {                                        // hintmask, cntrmask: implicit vstems, mask
        stems += depth / 2;
        p += 1 + (stems + 7) / 8;
      } else if (b == 12) {
        uint8_t e = p + 1 < end ? c[p + 1] : 0;
        if (e < 34 || e > 37) fail(Err::OutputInvalid, "glyph %u of the downgraded CFF uses the operator 12 %u", g, e);
        p += 2;  // hflex, flex, hflex1, flex1
      } else {
        p += 1;
      }
      depth = 0;
    }
    if (p > end) fail(Err::CffInvalid, "glyph %u's charstring ends inside an operand or a mask", g);
    deepest = std::max(deepest, depth);
  }
  if (deepest > kMaxStack) {
    fail(Err::OutputInvalid, "a charstring of the downgraded CFF holds %zu operands; CFF allows %zu", deepest, kMaxStack);
  }
  return deepest;
}

}  // namespace hbf
