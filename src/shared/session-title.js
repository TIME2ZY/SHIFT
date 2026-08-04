function buildSessionTitle(input, maxLength = 24) {
  const limit = Math.max(8, Number(maxLength) || 24);
  let title = String(input || "")
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return "";

  title = title
    .replace(/^@\S+\s*/, "")
    .replace(/^(?:请(?:你)?|麻烦(?:你)?|能否|可以|帮我|我想(?:请你)?|我觉得(?:还是)?|我认为)\s*/, "")
    .replace(/^[吧把，,：:\-—\s]+/, "");

  const firstSentence = title.split(/[。！？!?；;\n]/, 1)[0].trim();
  if (Array.from(firstSentence).length >= 6) title = firstSentence;
  title = title
    .replace(/[，,]\s*(?:你)?(?:认为|觉得)?(?:怎么样|如何|呢|吗).*$/u, "")
    .replace(/(?:可以吗|行吗|好吗|怎么样|如何呢|呢)$/u, "")
    .trim();
  if (!title) return "新会话";

  const chars = Array.from(title);
  if (chars.length <= limit) return title;
  const head = chars.slice(0, limit - 1).join("");
  const boundaries = [head.lastIndexOf("，"), head.lastIndexOf(","), head.lastIndexOf("：")];
  const boundary = Math.max(...boundaries);
  const compact = boundary >= 8 ? head.slice(0, boundary) : head;
  return `${compact.replace(/[，,：:\s]+$/u, "")}…`;
}

module.exports = { buildSessionTitle };
