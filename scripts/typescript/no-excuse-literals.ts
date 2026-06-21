export function maskLiterals(source: string): string {
  const chars = [...source];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
    } else if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
    } else if (char === '"' || char === "'") {
      index = maskQuotedLiteral(source, chars, index, char);
    } else if (isRegexLiteralStart(source, index)) {
      index = maskRegexLiteral(source, chars, index);
    }
  }
  return chars.join("");
}

export function maskComments(source: string): string {
  const chars = [...source];
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "/") continue;
    const next = source[index + 1];
    if (next === "/") {
      index = maskLineComment(source, chars, index);
    } else if (next === "*") {
      index = maskBlockComment(source, chars, index);
    }
  }
  return chars.join("");
}

function maskQuotedLiteral(source: string, chars: string[], start: number, quote: string): number {
  maskChar(chars, start);
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    maskChar(chars, index);
    if (char === "\\") {
      index++;
      maskChar(chars, index);
      continue;
    }
    if (char === quote) return index;
  }
  return source.length - 1;
}

function maskRegexLiteral(source: string, chars: string[], start: number): number {
  let inCharacterClass = false;
  maskChar(chars, start);
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    maskChar(chars, index);
    if (char === "\\") {
      index++;
      maskChar(chars, index);
      continue;
    }
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      return maskRegexFlags(source, chars, index + 1);
    }
  }
  return source.length - 1;
}

function skipLineComment(source: string, start: number): number {
  for (let index = start; index < source.length; index++) {
    if (source[index] === "\n") return index;
  }
  return source.length - 1;
}

function skipBlockComment(source: string, start: number): number {
  for (let index = start + 2; index < source.length; index++) {
    if (source[index] === "*" && source[index + 1] === "/") return index + 1;
  }
  return source.length - 1;
}

function maskRegexFlags(source: string, chars: string[], start: number): number {
  let last = start - 1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (!char || !/[A-Za-z]/.test(char)) break;
    maskChar(chars, index);
    last = index;
  }
  return last;
}

function maskLineComment(source: string, chars: string[], start: number): number {
  for (let index = start; index < source.length; index++) {
    if (source[index] === "\n") return index;
    maskChar(chars, index);
  }
  return source.length - 1;
}

function maskBlockComment(source: string, chars: string[], start: number): number {
  maskChar(chars, start);
  maskChar(chars, start + 1);
  for (let index = start + 2; index < source.length; index++) {
    maskChar(chars, index);
    if (source[index] === "*" && source[index + 1] === "/") {
      index++;
      maskChar(chars, index);
      return index;
    }
  }
  return source.length - 1;
}

function maskChar(chars: string[], index: number): void {
  if (chars[index] && chars[index] !== "\n") chars[index] = " ";
}

function isRegexLiteralStart(source: string, index: number): boolean {
  if (source[index] !== "/") return false;
  const next = source[index + 1];
  if (next === "/" || next === "*") return false;
  const previous = previousNonWhitespace(source, index);
  return previous === null || "([{=,:;!?".includes(previous);
}

function previousNonWhitespace(source: string, beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const char = source[index];
    if (char && !/\s/.test(char)) return char;
  }
  return null;
}
