export function formatChineseThinkingText(value: string) {
  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n");
}

export function normalizeMeetingMarkdown(value: string) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((segment) =>
      segment.startsWith("```") ? segment : normalizeMeetingMathText(segment)
    )
    .join("");
}

function normalizeMeetingMathText(value: string) {
  return value
    .replace(/\\\$\\\$([\s\S]*?)\\\$\\\$/g, (_, expression: string) => normalizeMathExpression(expression))
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression: string) => normalizeMathExpression(expression))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression: string) => normalizeMathExpression(expression))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => normalizeMathExpression(expression))
    .replace(/\\\$([^$\n]+?)\\\$/g, (_, expression: string) => normalizeMathExpression(expression))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix: string, expression: string) => `${prefix}${normalizeMathExpression(expression)}`);
}

function normalizeMathExpression(expression: string) {
  return expression
    .trim()
    .replace(/\\(?:text|mathrm)\{([^{}]*)\}/g, "$1")
    .replace(/\\times/g, "x")
    .replace(/\\cdot/g, "*")
    .replace(/\\leq/g, "<=")
    .replace(/\\geq/g, ">=")
    .replace(/\\neq/g, "!=")
    .replace(/\\left|\\right/g, "")
    .replace(/\\log/g, "log")
    .replace(/[{}]/g, "")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/\s+/g, " ");
}
