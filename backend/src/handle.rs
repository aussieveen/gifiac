//! Handle slugification/validation (SPEC-CLOUD.md §5) — kept in one place
//! so the picker's suggested slug and the submit endpoint's format rule
//! can never drift apart.

const MIN_LEN: usize = 2;
const MAX_LEN: usize = 30;

/// Lowercases, collapses any run of non-alphanumeric characters into a
/// single `-`, and trims leading/trailing `-` — a best-effort suggestion,
/// not a guarantee of validity (a display name that's all punctuation, or
/// too short, can still slugify to something `is_valid` rejects; the
/// picker is pre-filled, not locked, precisely so the user can fix that).
pub fn slugify(display_name: &str) -> String {
    let mut slug = String::with_capacity(display_name.len());
    let mut last_was_dash = false;
    for ch in display_name.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_end_matches('-').to_string()
}

/// Lowercase ASCII alphanumeric + hyphens, no leading/trailing/repeated
/// hyphens, within a reasonable length — the one format rule both the
/// submit endpoint and (implicitly, by construction) `slugify` follow.
pub fn is_valid(handle: &str) -> bool {
    if handle.len() < MIN_LEN || handle.len() > MAX_LEN {
        return false;
    }
    if handle.starts_with('-') || handle.ends_with('-') || handle.contains("--") {
        return false;
    }
    handle.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_lowercases_and_collapses_punctuation_and_spaces() {
        assert_eq!(slugify("Simon McWhinnie!!"), "simon-mcwhinnie");
    }

    #[test]
    fn slugify_collapses_a_run_of_separators_into_one_dash() {
        assert_eq!(slugify("a   b---c"), "a-b-c");
    }

    #[test]
    fn slugify_trims_trailing_punctuation() {
        assert_eq!(slugify("Dr. Simon."), "dr-simon");
    }

    #[test]
    fn slugify_of_an_empty_or_all_punctuation_name_is_empty() {
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn is_valid_accepts_lowercase_alphanumeric_and_single_hyphens() {
        assert!(is_valid("simon-mc2"));
        assert!(is_valid("ab"));
    }

    #[test]
    fn is_valid_rejects_uppercase_leading_trailing_or_doubled_hyphens() {
        assert!(!is_valid("Simon"));
        assert!(!is_valid("-simon"));
        assert!(!is_valid("simon-"));
        assert!(!is_valid("si--mon"));
    }

    #[test]
    fn is_valid_rejects_out_of_range_lengths() {
        assert!(!is_valid("a"));
        assert!(!is_valid(&"a".repeat(31)));
        assert!(is_valid(&"a".repeat(30)));
    }

    #[test]
    fn is_valid_rejects_other_punctuation_or_whitespace() {
        assert!(!is_valid("simon_mc"));
        assert!(!is_valid("simon mc"));
        assert!(!is_valid("simon.mc"));
    }
}
