// Some models emit tool calls in their TEXT (XML/markup they were trained on)
// instead of the structured tool_calls the API expects — and when the provider
// (notably LM Studio with certain local models) doesn't parse that format, the
// markup leaks into the content. freecode then sees text, not a tool call, and
// can't act. Detect that leakage so the turn-end signal can name it precisely.

const MARKERS: RegExp[] = [
  /<function[_-]?calls?\b/i, // <function_calls> / <function-calls>
  /<tool_call\b/i, // <tool_call>
  /<invoke\b/i, // <invoke name="...">
  /<function\s*=/i, // <function=Bash>
  /<parameter\s+name\s*=/i, // <parameter name="..." value="...">
  /<\|tool_call\|>|<\|tool\|>/i, // special-token tool markers
];

/** True when the text contains tool-call markup the provider failed to parse
 *  into a structured call (so it arrived as content instead). */
export function looksLikeTextToolCall(text: string): boolean {
  if (!text) return false;
  return MARKERS.some((re) => re.test(text));
}
