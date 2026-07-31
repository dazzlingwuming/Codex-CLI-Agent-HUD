import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/**
 * @param {string} value
 * @param {number} width
 */
export function truncateDisplay(value, width) {
  if (width <= 0) {
    return "";
  }
  if (stringWidth(value) <= width) {
    return value;
  }
  if (width === 1) {
    return "…";
  }

  let result = "";
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (stringWidth(`${result}${segment}…`) > width) {
      break;
    }
    result += segment;
  }
  return `${result}…`;
}

/**
 * @param {string} value
 * @param {number} width
 */
export function fitDisplay(value, width) {
  const truncated = truncateDisplay(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - stringWidth(truncated)))}`;
}

/**
 * @param {number} milliseconds
 */
export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
