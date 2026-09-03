"""Small bounded KiCad S-expression reader and deterministic writer.

The parser intentionally implements only the lexical surface used by KiCad
project files: lists, atoms, and quoted UTF-8 strings.  It has explicit size,
token, and nesting limits so untrusted project artifacts cannot turn parsing
into an unbounded operation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from .errors import KiCadSyntaxError


@dataclass(frozen=True, slots=True)
class Atom:
    value: str

    def __post_init__(self) -> None:
        if not self.value or any(character.isspace() for character in self.value):
            raise KiCadSyntaxError("S-expression atoms must be non-empty and whitespace-free")
        if any(character in '()"' for character in self.value):
            raise KiCadSyntaxError("S-expression atom contains a reserved character")


@dataclass(frozen=True, slots=True)
class Quoted:
    value: str


SExpr: TypeAlias = Atom | Quoted | tuple["SExpr", ...]


@dataclass(frozen=True, slots=True)
class ParseLimits:
    maximum_bytes: int = 32 * 1024 * 1024
    maximum_tokens: int = 2_000_000
    maximum_depth: int = 128
    maximum_atom_characters: int = 1_000_000

    def __post_init__(self) -> None:
        if min(
            self.maximum_bytes,
            self.maximum_tokens,
            self.maximum_depth,
            self.maximum_atom_characters,
        ) <= 0:
            raise ValueError("all S-expression parse limits must be positive")


DEFAULT_LIMITS = ParseLimits()


def atom(value: str | int) -> Atom:
    return Atom(str(value))


def quoted(value: str) -> Quoted:
    if not isinstance(value, str):
        raise TypeError("quoted S-expression value must be a string")
    return Quoted(value)


def node(head: str, *children: SExpr) -> tuple[SExpr, ...]:
    return (Atom(head), *children)


def head(expression: SExpr) -> str | None:
    if (
        isinstance(expression, tuple)
        and expression
        and isinstance(expression[0], Atom)
    ):
        return expression[0].value
    return None


def scalar_text(expression: SExpr, *, label: str) -> str:
    if isinstance(expression, (Atom, Quoted)):
        return expression.value
    raise KiCadSyntaxError(f"{label} must be an atom or quoted string")


def parse(source: bytes, *, limits: ParseLimits = DEFAULT_LIMITS) -> SExpr:
    """Parse exactly one UTF-8 S-expression under explicit resource limits."""

    if not isinstance(source, bytes):
        raise TypeError("KiCad source must be bytes")
    if len(source) > limits.maximum_bytes:
        raise KiCadSyntaxError(
            f"KiCad source exceeds the {limits.maximum_bytes}-byte parser limit"
        )
    if source.startswith(b"\xef\xbb\xbf"):
        raise KiCadSyntaxError("UTF-8 BOM is not accepted in KiCad project input")
    try:
        text = source.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise KiCadSyntaxError("KiCad project input must be valid UTF-8") from exc

    roots: list[SExpr] = []
    stack: list[list[SExpr]] = []
    index = 0
    token_count = 0

    def append_token(token: SExpr) -> None:
        nonlocal token_count
        token_count += 1
        if token_count > limits.maximum_tokens:
            raise KiCadSyntaxError(
                f"KiCad source exceeds the {limits.maximum_tokens}-token parser limit"
            )
        if stack:
            stack[-1].append(token)
        else:
            roots.append(token)

    while index < len(text):
        character = text[index]
        if character.isspace():
            index += 1
            continue
        if character == "(":
            token_count += 1
            if token_count > limits.maximum_tokens:
                raise KiCadSyntaxError(
                    f"KiCad source exceeds the {limits.maximum_tokens}-token parser limit"
                )
            stack.append([])
            if len(stack) > limits.maximum_depth:
                raise KiCadSyntaxError(
                    f"KiCad source exceeds the {limits.maximum_depth}-level nesting limit"
                )
            index += 1
            continue
        if character == ")":
            if not stack:
                raise KiCadSyntaxError(f"unexpected ')' at character {index}")
            completed: SExpr = tuple(stack.pop())
            append_token(completed)
            index += 1
            continue
        if character == '"':
            index += 1
            value: list[str] = []
            while index < len(text):
                current = text[index]
                if current == '"':
                    index += 1
                    break
                if current == "\\":
                    index += 1
                    if index >= len(text):
                        raise KiCadSyntaxError("unterminated escape in quoted string")
                    escaped = text[index]
                    translations = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}
                    if escaped not in translations:
                        raise KiCadSyntaxError(
                            f"unsupported quoted-string escape '\\{escaped}'"
                        )
                    value.append(translations[escaped])
                    index += 1
                    continue
                if ord(current) < 0x20 and current not in {"\t"}:
                    raise KiCadSyntaxError("quoted string contains an unescaped control character")
                value.append(current)
                if len(value) > limits.maximum_atom_characters:
                    raise KiCadSyntaxError("quoted string exceeds the parser character limit")
                index += 1
            else:
                raise KiCadSyntaxError("unterminated quoted string")
            append_token(Quoted("".join(value)))
            continue

        start = index
        while (
            index < len(text)
            and not text[index].isspace()
            and text[index] not in "()\""
        ):
            index += 1
        if index == start:
            raise KiCadSyntaxError(f"invalid character at offset {index}")
        atom_value = text[start:index]
        if len(atom_value) > limits.maximum_atom_characters:
            raise KiCadSyntaxError("atom exceeds the parser character limit")
        append_token(Atom(atom_value))

    if stack:
        raise KiCadSyntaxError("unterminated S-expression list")
    if len(roots) != 1:
        raise KiCadSyntaxError("KiCad project input must contain exactly one root expression")
    return roots[0]


def canonical_text(expression: SExpr) -> str:
    """Return an unambiguous one-line representation used in diagnostics."""

    if isinstance(expression, Atom):
        return expression.value
    if isinstance(expression, Quoted):
        return _quoted_text(expression.value)
    return "(" + " ".join(canonical_text(child) for child in expression) + ")"


def render(expression: SExpr) -> bytes:
    """Render a deterministic, human-readable UTF-8 S-expression."""

    return (_pretty(expression, 0) + "\n").encode("utf-8")


def _pretty(expression: SExpr, depth: int) -> str:
    if not isinstance(expression, tuple):
        return canonical_text(expression)
    if not expression:
        return "()"
    inline = canonical_text(expression)
    if len(inline) <= 100 and not any(isinstance(child, tuple) for child in expression[1:]):
        return inline
    indentation = "  " * depth
    child_indentation = "  " * (depth + 1)
    rendered: list[str] = []
    for child in expression[1:]:
        child_text = _pretty(child, depth + 1)
        if isinstance(child, tuple):
            rendered.append(child_indentation + child_text)
        else:
            rendered.append(child_text)
    if all(not isinstance(child, tuple) for child in expression[1:]):
        return inline
    prefix = "(" + canonical_text(expression[0])
    return prefix + "\n" + "\n".join(rendered) + "\n" + indentation + ")"


def _quoted_text(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'
