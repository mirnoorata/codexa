import type { SyntaxNode } from "./context.js";

export function decoratorsForNode(node: SyntaxNode, sourceText: string): string[] {
  const decorators: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === "decorator") {
      decorators.push(sourceText.slice(child.startIndex, child.endIndex).trim());
    }
  }
  return decorators;
}

export function callName(node: SyntaxNode): string | null {
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (!fn) {
    return null;
  }
  const compact = compactCallableName(fn);
  if (compact) {
    return compact;
  }
  return fn.text.length <= 120 ? fn.text : truncateInline(fn.text, 120);
}

export function dynamicImportSpecifier(node: SyntaxNode): string | undefined {
  const fn = node.childForFieldName("function") ?? node.namedChild(0);
  if (fn?.text !== "import") {
    return undefined;
  }
  const argument = node.namedChildren.find((child) => child !== fn && child.type === "arguments")?.namedChild(0);
  const text = argument?.text ?? "";
  return /^["'][^"']+["']$/.test(text) ? text.slice(1, -1) : undefined;
}

function compactCallableName(node: SyntaxNode): string | null {
  if (["identifier", "property_identifier"].includes(node.type)) {
    return node.text;
  }
  if (["attribute", "member_expression"].includes(node.type)) {
    const property = node.childForFieldName("property") ?? node.childForFieldName("attribute") ?? node.namedChildren.at(-1);
    const object = node.childForFieldName("object");
    const propertyName = property?.text;
    if (!propertyName) {
      return truncateInline(node.text, 120);
    }
    if (!object || ["call_expression", "subscript_expression"].includes(object.type)) {
      return truncateInline(propertyName, 120);
    }
    const objectName = compactCallableName(object);
    if (!objectName) {
      return truncateInline(propertyName, 120);
    }
    return compactDottedName(`${objectName}.${propertyName}`);
  }
  if (node.type === "subscript_expression") {
    const object = node.childForFieldName("object") ?? node.namedChild(0);
    const objectName = object ? compactCallableName(object) : undefined;
    return objectName ? `${objectName}[]` : truncateInline(node.text, 120);
  }
  return null;
}

function compactDottedName(value: string): string {
  const parts = value.split(".").filter(Boolean);
  return truncateInline(parts.slice(-3).join("."), 120);
}

function truncateInline(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function jsxElementName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((child) => ["identifier", "nested_identifier", "member_expression"].includes(child.type));
  if (!nameNode) {
    return null;
  }
  return nameNode.text.length <= 120 ? nameNode.text : null;
}
