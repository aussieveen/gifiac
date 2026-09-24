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

/// Lowercase, URL-safe form of a handle — the base slug candidate before
/// any collision suffix (see `db::set_handle`). Unlike `slugify` above
/// (which collapses *any* non-alphanumeric run, for an arbitrary display
/// name), this only lowercases: a valid handle is already restricted to
/// alphanumeric + hyphen/underscore by `is_valid`, so a hyphen/underscore
/// in a handle should still be a hyphen/underscore in its slug, not get
/// collapsed away.
pub fn base_slug(handle: &str) -> String {
    handle.to_lowercase()
}

/// The Nth candidate slug when `base` is already taken by another user —
/// 1 is the base itself, 2+ appends the attempt number directly with no
/// separator ("sim_mc", "sim_mc2", "sim_mc3", ...): two different handles
/// that case-fold to the same slug both get to exist, disambiguated by
/// suffix, rather than the second being rejected outright.
pub fn slug_candidate(base: &str, attempt: u32) -> String {
    if attempt <= 1 {
        base.to_string()
    } else {
        format!("{base}{attempt}")
    }
}

/// ASCII alphanumeric (either case) + hyphens/underscores as separators,
/// no leading/trailing/doubled separator, within a reasonable length —
/// the one format rule the submit endpoint follows (`slugify` above is
/// unaffected — it only ever produces the lowercase-hyphenated subset,
/// still valid by this same rule, since it's just a suggestion).
pub fn is_valid(handle: &str) -> bool {
    if handle.len() < MIN_LEN || handle.len() > MAX_LEN {
        return false;
    }
    fn is_separator(c: char) -> bool {
        c == '-' || c == '_'
    }
    if handle.starts_with(is_separator) || handle.ends_with(is_separator) {
        return false;
    }
    if handle.chars().zip(handle.chars().skip(1)).any(|(a, b)| is_separator(a) && is_separator(b)) {
        return false;
    }
    handle.chars().all(|c| c.is_ascii_alphanumeric() || is_separator(c))
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
    fn base_slug_lowercases_without_touching_separators() {
        assert_eq!(base_slug("Sim_Mc"), "sim_mc");
        assert_eq!(base_slug("SIMON-MC"), "simon-mc");
    }

    #[test]
    fn slug_candidate_is_bare_on_the_first_attempt_and_suffixed_after() {
        assert_eq!(slug_candidate("sim_mc", 1), "sim_mc");
        assert_eq!(slug_candidate("sim_mc", 2), "sim_mc2");
        assert_eq!(slug_candidate("sim_mc", 3), "sim_mc3");
    }

    #[test]
    fn is_valid_accepts_lowercase_alphanumeric_and_single_hyphens() {
        assert!(is_valid("simon-mc2"));
        assert!(is_valid("ab"));
    }

    #[test]
    fn is_valid_accepts_uppercase_and_underscores() {
        assert!(is_valid("Simon"));
        assert!(is_valid("SIMON_MC"));
        assert!(is_valid("simon_mc2"));
    }

    #[test]
    fn is_valid_rejects_leading_trailing_or_doubled_separators() {
        assert!(!is_valid("-simon"));
        assert!(!is_valid("_simon"));
        assert!(!is_valid("simon-"));
        assert!(!is_valid("simon_"));
        assert!(!is_valid("si--mon"));
        assert!(!is_valid("si__mon"));
        assert!(!is_valid("si-_mon"));
        assert!(!is_valid("si_-mon"));
    }

    #[test]
    fn is_valid_rejects_out_of_range_lengths() {
        assert!(!is_valid("a"));
        assert!(!is_valid(&"a".repeat(31)));
        assert!(is_valid(&"a".repeat(30)));
    }

    #[test]
    fn is_valid_rejects_other_punctuation_or_whitespace() {
        assert!(!is_valid("simon mc"));
        assert!(!is_valid("simon.mc"));
    }
}
