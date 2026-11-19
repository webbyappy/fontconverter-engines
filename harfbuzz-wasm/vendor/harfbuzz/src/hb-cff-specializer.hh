/*
 * CFF CharString Specializer
 *
 * Optimizes CharString bytecode by using specialized operators
 * (hlineto, vlineto, hhcurveto, etc.) to save bytes and respects
 * CFF1 stack limit (48 values).
 *
 * Based on fontTools.cffLib.specializer
 */

#ifndef HB_CFF_SPECIALIZER_HH
#define HB_CFF_SPECIALIZER_HH

#include "hb.hh"
#include "hb-cff-interp-cs-common.hh"

namespace CFF {

/* CharString command representation - forward declared in hb-subset-cff-common.hh */

/* Specialization must preserve nonzero fractional displacements. */
static inline bool
is_zero (const number_t &n)
{
  return n.to_real () == 0.;
}

/* harfbuzz-wasm patch 2: the CFF2-to-CFF1 downgrade must leave no more operands on the stack than CFF1 allows (48;
 * CFF2 allows 513). generalize_commands kept rcurveline, rlinecurve and the hh/vv/hv/vh curve operators as they came, so
 * a CFF2 charstring's 56-operand rcurveline reached the CFF1 output (OTS: "Failed validating CharStrings INDEX"). As
 * fontTools' generalizeCommands does, every one of them is broken into single rlineto and rrcurveto segments, which the
 * combining passes below join within maxstack. Stem hints are not split: a stem operator over 48 operands (none in the
 * test fonts) stays, and hbfont's output check refuses the font (cff1_check_stack). */
static inline void
push_line_ (hb_vector_t<cs_command_t> &out, const number_t &dx, const number_t &dy)
{
  cs_command_t seg (OpCode_rlineto);
  seg.args.alloc (2);
  seg.args.push (dx);
  seg.args.push (dy);
  out.push (seg);
}

static inline void
push_curve_ (hb_vector_t<cs_command_t> &out,
	     const number_t &dx1, const number_t &dy1, const number_t &dx2,
	     const number_t &dy2, const number_t &dx3, const number_t &dy3)
{
  cs_command_t seg (OpCode_rrcurveto);
  seg.args.alloc (6);
  seg.args.push (dx1); seg.args.push (dy1); seg.args.push (dx2);
  seg.args.push (dy2); seg.args.push (dx3); seg.args.push (dy3);
  out.push (seg);
}

/* Generalize CharString commands to canonical form
 *
 * Converts all operators to their general forms and breaks down
 * multi-segment operators into single segments. This ensures we
 * start from a clean baseline before specialization.
 *
 * Based on fontTools.cffLib.specializer.generalizeCommands
 */
static void
generalize_commands (hb_vector_t<cs_command_t> &commands)
{
  hb_vector_t<cs_command_t> result;
  result.alloc (commands.length * 2);  /* Estimate: might expand */

  for (unsigned i = 0; i < commands.length; i++)
  {
    auto &cmd = commands[i];

    switch (cmd.op)
    {
      case OpCode_hmoveto:
      case OpCode_vmoveto:
      {
        /* Convert to rmoveto with explicit dx,dy */
        cs_command_t gen (OpCode_rmoveto);
        gen.args.alloc (2);

        if (cmd.op == OpCode_hmoveto && cmd.args.length >= 1)
        {
          gen.args.push (cmd.args[0]);  /* dx */
          number_t zero; zero.set_int (0);
          gen.args.push (zero);          /* dy = 0 */
        }
        else if (cmd.op == OpCode_vmoveto && cmd.args.length >= 1)
        {
          number_t zero; zero.set_int (0);
          gen.args.push (zero);          /* dx = 0 */
          gen.args.push (cmd.args[0]);  /* dy */
        }
        result.push (gen);
        break;
      }

      case OpCode_hlineto:
      case OpCode_vlineto:
      {
        /* Convert h/v lineto to rlineto, breaking into single segments
         * hlineto alternates: dx1 (→ dx1,0) dy1 (→ 0,dy1) dx2 (→ dx2,0) ...
         * vlineto alternates: dy1 (→ 0,dy1) dx1 (→ dx1,0) dy2 (→ 0,dy2) ... */
        bool is_h = (cmd.op == OpCode_hlineto);
        number_t zero; zero.set_int (0);

        for (unsigned j = 0; j < cmd.args.length; j++)
        {
          cs_command_t seg (OpCode_rlineto);
          seg.args.alloc (2);

          bool is_horizontal = is_h ? (j % 2 == 0) : (j % 2 == 1);
          if (is_horizontal)
          {
            seg.args.push (cmd.args[j]);  /* dx */
            seg.args.push (zero);          /* dy = 0 */
          }
          else
          {
            seg.args.push (zero);          /* dx = 0 */
            seg.args.push (cmd.args[j]);  /* dy */
          }
          result.push (seg);
        }
        break;
      }

      case OpCode_rlineto:
      {
        /* Break into single segments (dx,dy pairs) */
        for (unsigned j = 0; j + 1 < cmd.args.length; j += 2)
        {
          cs_command_t seg (OpCode_rlineto);
          seg.args.alloc (2);
          seg.args.push (cmd.args[j]);
          seg.args.push (cmd.args[j + 1]);
          result.push (seg);
        }
        break;
      }

      case OpCode_rrcurveto:
      {
        /* Break into single segments (6 args each) */
        for (unsigned j = 0; j + 5 < cmd.args.length; j += 6)
        {
          cs_command_t seg (OpCode_rrcurveto);
          seg.args.alloc (6);
          for (unsigned k = 0; k < 6; k++)
            seg.args.push (cmd.args[j + k]);
          result.push (seg);
        }
        break;
      }

      /* harfbuzz-wasm patch 2 (see push_line_): the remaining curve and line operators. A malformed operand count is
       * kept as it came. */
      case OpCode_rcurveline:  /* {dxa dya dxb dyb dxc dyc}+ dxd dyd */
      {
        const unsigned n = cmd.args.length;
        if (n < 8 || (n - 2) % 6) { result.push (cmd); break; }
        const auto &a = cmd.args;
        for (unsigned j = 0; j + 2 < n; j += 6)
          push_curve_ (result, a[j], a[j + 1], a[j + 2], a[j + 3], a[j + 4], a[j + 5]);
        push_line_ (result, a[n - 2], a[n - 1]);
        break;
      }

      case OpCode_rlinecurve:  /* {dxa dya}+ dxb dyb dxc dyc dxd dyd */
      {
        const unsigned n = cmd.args.length;
        if (n < 8 || (n - 6) % 2) { result.push (cmd); break; }
        const auto &a = cmd.args;
        for (unsigned j = 0; j + 6 < n; j += 2)
          push_line_ (result, a[j], a[j + 1]);
        push_curve_ (result, a[n - 6], a[n - 5], a[n - 4], a[n - 3], a[n - 2], a[n - 1]);
        break;
      }

      case OpCode_hhcurveto:  /* dy1? {dxa dxb dyb dxc}+ */
      case OpCode_vvcurveto:  /* dx1? {dya dxb dyb dyc}+ */
      {
        const unsigned n = cmd.args.length;
        const unsigned first = n & 1;
        if (n - first < 4 || (n - first) % 4) { result.push (cmd); break; }
        const auto &a = cmd.args;
        number_t zero; zero.set_int (0);
        for (unsigned j = first; j < n; j += 4)
        {
          const number_t &side = (first && j == first) ? a[0] : zero;
          if (cmd.op == OpCode_hhcurveto)
            push_curve_ (result, a[j], side, a[j + 1], a[j + 2], a[j + 3], zero);
          else
            push_curve_ (result, side, a[j], a[j + 1], a[j + 2], zero, a[j + 3]);
        }
        break;
      }

      case OpCode_hvcurveto:  /* curves alternating between a horizontal and a vertical start; a 5th operand ends the */
      case OpCode_vhcurveto:  /* last curve off its axis */
      {
        const unsigned n = cmd.args.length;
        if (n < 4 || (n % 4 != 0 && n % 4 != 1)) { result.push (cmd); break; }
        const auto &a = cmd.args;
        number_t zero; zero.set_int (0);
        const unsigned curves = n / 4;
        bool horizontal = cmd.op == OpCode_hvcurveto;
        for (unsigned c = 0; c < curves; c++)
        {
          const unsigned j = 4 * c;
          const number_t &last = (c + 1 == curves && n % 4 == 1) ? a[n - 1] : zero;
          if (horizontal)
            push_curve_ (result, a[j], zero, a[j + 1], a[j + 2], last, a[j + 3]);
          else
            push_curve_ (result, zero, a[j], a[j + 1], a[j + 2], a[j + 3], last);
          horizontal = !horizontal;
        }
        break;
      }

      default:
        /* Keep other operators as-is */
        result.push (cmd);
        break;
    }
  }

  /* Replace commands with generalized result */
  commands.clear ();
  for (unsigned i = 0; i < result.length; i++)
    commands.push (result[i]);
}

/* Specialize CharString commands to optimize bytecode size
 *
 * Follows fontTools approach:
 * 0. Generalize: Break down to canonical single-segment form
 * 1. Specialize: Convert rmoveto/rlineto to h/v variants when dx or dy is zero
 * 2. Combine: Merge adjacent compatible operators
 * 3. Enforce: Respect maxstack limit (default 48 for CFF1)
 *
 * This ensures we never exceed stack depth while optimizing bytecode.
 */
static void
specialize_commands (hb_vector_t<cs_command_t> &commands,
                     unsigned maxstack = 48)
{
  if (commands.length == 0) return;

  /* Pass 0: Generalize to canonical form (fontTools does this first) */
  generalize_commands (commands);

  /* Pass 1: Specialize rmoveto/rlineto into h/v variants */
  for (unsigned i = 0; i < commands.length; i++)
  {
    auto &cmd = commands[i];

    if ((cmd.op == OpCode_rmoveto || cmd.op == OpCode_rlineto) &&
        cmd.args.length == 2)
    {
      bool dx_zero = is_zero (cmd.args[0]);
      bool dy_zero = is_zero (cmd.args[1]);

      if (dx_zero && !dy_zero)
      {
        /* Vertical movement (dx=0): keep only dy */
        cmd.op = (cmd.op == OpCode_rmoveto) ? OpCode_vmoveto : OpCode_vlineto;
        /* Shift dy to position 0 */
        cmd.args[0] = cmd.args[1];
        cmd.args.resize (1);
      }
      else if (!dx_zero && dy_zero)
      {
        /* Horizontal movement (dy=0): keep only dx */
        cmd.op = (cmd.op == OpCode_rmoveto) ? OpCode_hmoveto : OpCode_hlineto;
        cmd.args.resize (1);  /* Keep only dx */
      }
      /* else: both zero or both non-zero, keep as rmoveto/rlineto */
    }
  }

  /* Pass 2: Combine adjacent hlineto/vlineto operators
   * hlineto can take multiple args alternating with vlineto
   * This saves operator bytes */
  for (int i = (int)commands.length - 1; i > 0; i--)
  {
    auto &cmd = commands[i];
    auto &prev = commands[i-1];

    /* Different starting directions can combine only after an odd number
     * of alternating arguments in the preceding command. */
    if (((prev.op == OpCode_hlineto && cmd.op == OpCode_vlineto) ||
         (prev.op == OpCode_vlineto && cmd.op == OpCode_hlineto)) &&
        (prev.args.length & 1))
    {
      /* Check stack depth */
      unsigned combined_args = prev.args.length + cmd.args.length;
      if (combined_args < maxstack)
      {
        /* Merge into first command, keep its operator */
        for (unsigned j = 0; j < cmd.args.length; j++)
          prev.args.push (cmd.args[j]);
        commands.remove_ordered (i);
        i++;  /* Adjust for removed element */
      }
    }
  }

  /* Pass 3: Combine adjacent identical operators */
  for (int i = (int)commands.length - 1; i > 0; i--)
  {
    auto &cmd = commands[i];
    auto &prev = commands[i-1];

    /* Same-direction h/v commands can combine only after an even number
     * of alternating arguments. Other repeatable operators concatenate. */
    if (prev.op == cmd.op &&
        (cmd.op == OpCode_rlineto || cmd.op == OpCode_rrcurveto ||
         ((cmd.op == OpCode_hlineto || cmd.op == OpCode_vlineto) &&
          !(prev.args.length & 1))))
    {
      /* Check stack depth */
      unsigned combined_args = prev.args.length + cmd.args.length;
      if (combined_args < maxstack)
      {
        /* Merge args */
        for (unsigned j = 0; j < cmd.args.length; j++)
          prev.args.push (cmd.args[j]);
        commands.remove_ordered (i);
        i++;  /* Adjust for removed element */
      }
    }
  }
}

/* Encode commands back to binary CharString */
static bool
encode_commands (const hb_vector_t<cs_command_t> &commands,
                 str_buff_t &output)
{
  for (const auto &cmd : commands)
  {
    str_encoder_t encoder (output);

    /* Encode arguments */
    for (const auto &arg : cmd.args)
      encoder.encode_num_cs (arg);

    /* Encode operator */
    if (cmd.op != OpCode_Invalid)
      encoder.encode_op (cmd.op);

    /* hintmask/cntrmask are followed by raw mask bytes. */
    if (cmd.op == OpCode_hintmask || cmd.op == OpCode_cntrmask)
    {
      for (const auto &byte : cmd.mask_bytes)
        encoder.encode_byte (byte);
    }

    if (encoder.in_error ())
      return false;
  }

  return true;
}

} /* namespace CFF */

#endif /* HB_CFF_SPECIALIZER_HH */
