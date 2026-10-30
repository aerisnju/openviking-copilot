const CJK_RANGES = [
  [0x3000, 0x30ff],
  [0x3400, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
];

const CONTEXT_OPEN = "<openviking-context>\n";
const CONTEXT_CLOSE = "\n</openviking-context>";
const TRUNCATION_MARKER = "\n... [OpenViking context trimmed to fit the token budget] ...";

function tokenCost(text) {
  let cost = 0;
  for (const character of String(text ?? "")) {
    const codePoint = character.codePointAt(0);
    const isCjk = CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
    cost += isCjk || codePoint > 0xffff ? 1.5 : 0.25;
  }
  return cost;
}

export function estimateContextTokens(text) {
  return Math.ceil(tokenCost(text));
}

function truncateToCost(text, budget) {
  let result = "";
  let cost = 0;
  for (const character of text) {
    const nextCost = tokenCost(character);
    if (cost + nextCost > budget) break;
    result += character;
    cost += nextCost;
  }
  return result.trimEnd();
}

export function boundRecallContext(text, maxTokens) {
  if (typeof text !== "string" || !text) {
    return { text: text || "", truncated: false, estimatedTokens: 0 };
  }
  const budget = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
    ? Math.floor(Number(maxTokens))
    : 1600;
  const estimatedTokens = estimateContextTokens(text);
  if (estimatedTokens <= budget) return { text, truncated: false, estimatedTokens };

  let prefix = "";
  let suffix = "";
  let body = text;
  if (text.startsWith(CONTEXT_OPEN) && text.endsWith(CONTEXT_CLOSE)) {
    const introEnd = text.indexOf("\n", CONTEXT_OPEN.length);
    if (introEnd >= 0) {
      prefix = text.slice(0, introEnd + 1);
      suffix = CONTEXT_CLOSE;
      body = text.slice(introEnd + 1, -CONTEXT_CLOSE.length);
    }
  }

  const fixedCost = tokenCost(prefix + TRUNCATION_MARKER + suffix);
  if (Math.ceil(fixedCost) > budget) {
    // The host's envelope grew (a long orientation sentence now precedes the
    // content), so a tight budget can no longer fit prefix + marker + suffix.
    // Fall back to the bare markers plus the truncation marker rather than
    // dropping the context entirely: the caller still learns that memory
    // existed and was trimmed, which is what the budget is protecting.
    const minimal = `${CONTEXT_OPEN}${TRUNCATION_MARKER.trimStart()}\n${CONTEXT_CLOSE}`;
    if (tokenCost(minimal) <= budget) {
      return { text: minimal, truncated: true, estimatedTokens: estimateContextTokens(minimal) };
    }
    return { text: "", truncated: true, estimatedTokens: 0 };
  }
  const bodyBudget = Math.max(0, budget - Math.ceil(fixedCost));
  const bounded = `${prefix}${truncateToCost(body, bodyBudget)}${TRUNCATION_MARKER}${suffix}`;
  return {
    text: bounded,
    truncated: true,
    estimatedTokens: estimateContextTokens(bounded),
  };
}
