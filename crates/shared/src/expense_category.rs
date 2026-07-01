use crate::categories::{coerce_category, Category};

#[must_use]
pub fn coerce_expense_category(value: Option<&str>, note: Option<&str>) -> Category {
    match value.map(coerce_category).unwrap_or(Category::Other) {
        Category::Income | Category::Other => category_from_expense_note(note),
        category => category,
    }
}

fn category_from_expense_note(note: Option<&str>) -> Category {
    let Some(note) = note else {
        return Category::Other;
    };
    for word in note
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
    {
        if word.is_empty() {
            continue;
        }
        let hit = coerce_category(word);
        if !matches!(hit, Category::Other | Category::Income) {
            return hit;
        }
    }
    Category::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevents_expenses_from_becoming_income() {
        assert_eq!(
            coerce_expense_category(Some("Income"), Some("grab")),
            Category::Transport
        );
        assert_eq!(
            coerce_expense_category(Some("Other"), Some("food")),
            Category::Food
        );
        assert_eq!(
            coerce_expense_category(Some("Bills"), None),
            Category::Bills
        );
    }
}
