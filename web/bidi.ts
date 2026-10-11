const RTL_LETTER = /[֐-׿؀-ۿݐ-ݿיִ-﷿ﹰ-﻿]/g;
const LTR_LETTER = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

/**
 * The direction of `text` by which script most of its letters are in, so a Hebrew title that opens with "HRBP" still
 * reads right to left; undefined when it has no letters and should follow its container.
 */
export function textDirection(text: string | null | undefined): "rtl" | "ltr" | undefined {
  if (!text) return undefined;
  const rtl = text.match(RTL_LETTER)?.length ?? 0;
  const ltr = text.match(LTR_LETTER)?.length ?? 0;
  if (!rtl && !ltr) return undefined;
  return rtl > ltr ? "rtl" : "ltr";
}
