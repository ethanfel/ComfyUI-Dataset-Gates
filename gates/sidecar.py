"""Pure sidecar-file planning: filename resolution, extension allowlist, and
duplicate detection. No comfy/torch imports so it stays unit-testable."""
import os

# Plain-text / data formats only — never image or executable extensions.
ALLOWED_EXTENSIONS = {
    ".txt", ".caption", ".json", ".yaml", ".yml", ".md",
    ".csv", ".tsv", ".xml", ".log", ".ini", ".toml",
}


def normalize_ext(ext):
    """Sanitize an extension to a leading-dot basename and allowlist it."""
    ext = os.path.basename((ext or "").strip())
    if ext and not ext.startswith("."):
        ext = "." + ext
    if ext.lower() not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Disallowed sidecar extension {ext!r}. "
            f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    return ext


def sanitize_name(name):
    """Reduce a name field to a bare filename token (no path traversal)."""
    return os.path.basename((name or "").strip())


def append_spec(chain, content, name, ext):
    """Return a new chain list with this sidecar spec appended (no mutation)."""
    out = list(chain) if chain else []
    out.append({"content": content, "name": name, "ext": ext})
    return out


def build_plan(specs):
    """Resolve specs to a list of (suffix, content), where the file written is
    `<image_base> + suffix` and suffix is `name + ext`. Validates extensions and
    rejects duplicate filenames, raising ValueError *before* any I/O so a bad
    chain writes nothing."""
    seen = set()
    plan = []
    for s in specs or []:
        ext = normalize_ext(s.get("ext"))
        name = sanitize_name(s.get("name"))
        suffix = f"{name}{ext}"
        if suffix in seen:
            raise ValueError(
                f"Duplicate sidecar file '<base>{suffix}': two sidecars resolve "
                f"to the same name (name={name!r}, ext={ext}). "
                f"Give one a distinct name.")
        seen.add(suffix)
        plan.append((suffix, s.get("content", "")))
    return plan
