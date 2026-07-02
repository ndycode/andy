use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Category {
    Food,
    Transport,
    Bills,
    Shopping,
    Health,
    Entertainment,
    #[serde(rename = "Savings/Goals")]
    SavingsGoals,
    Income,
    Other,
}

impl Category {
    pub const ALL: [Self; 9] = [
        Self::Food,
        Self::Transport,
        Self::Bills,
        Self::Shopping,
        Self::Health,
        Self::Entertainment,
        Self::SavingsGoals,
        Self::Income,
        Self::Other,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Food => "Food",
            Self::Transport => "Transport",
            Self::Bills => "Bills",
            Self::Shopping => "Shopping",
            Self::Health => "Health",
            Self::Entertainment => "Entertainment",
            Self::SavingsGoals => "Savings/Goals",
            Self::Income => "Income",
            Self::Other => "Other",
        }
    }
}

impl fmt::Display for Category {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Category {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Category::ALL
            .into_iter()
            .find(|category| category.as_str() == value)
            .ok_or(())
    }
}

#[must_use]
pub fn coerce_category(value: impl AsRef<str>) -> Category {
    let raw = value.as_ref();
    if let Ok(category) = Category::from_str(raw) {
        return category;
    }

    let key = raw.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Category::Other;
    }

    if let Some(category) = Category::ALL
        .into_iter()
        .find(|category| category.as_str().eq_ignore_ascii_case(&key))
    {
        return category;
    }

    match key.as_str() {
        "groceries" | "grocery" | "meal" | "meals" | "lunch" | "dinner" | "breakfast"
        | "merienda" | "dining" | "restaurant" | "coffee" | "tea" | "matcha" | "milktea"
        | "jollibee" | "mcdo" | "mcdonalds" | "snack" | "snacks" => Category::Food,
        "transportation" | "transpo" | "commute" | "gas" | "gasoline" | "fuel" | "fare"
        | "grab" | "taxi" | "ride" | "parking" | "toll" => Category::Transport,
        "bill" | "bills" | "utility" | "utilities" | "rent" | "netflix" | "electricity"
        | "electric" | "water" | "internet" | "load" | "subscription" => Category::Bills,
        "shop" | "shopping" | "clothes" | "clothing" => Category::Shopping,
        "health" | "medical" | "medicine" | "meds" | "pharmacy" | "doctor" => Category::Health,
        "entertainment" | "movie" | "movies" | "games" | "gaming" => Category::Entertainment,
        "savings" | "saving" | "goal" | "goals" => Category::SavingsGoals,
        "income" | "salary" | "sweldo" | "wage" | "wages" | "pay" | "paycheck" => Category::Income,
        _ => Category::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_strings_are_exact() {
        let values: Vec<_> = Category::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            values,
            [
                "Food",
                "Transport",
                "Bills",
                "Shopping",
                "Health",
                "Entertainment",
                "Savings/Goals",
                "Income",
                "Other"
            ]
        );
    }

    #[test]
    fn coerces_canonical_and_synonyms() {
        assert_eq!(coerce_category("Food"), Category::Food);
        assert_eq!(coerce_category(" food "), Category::Food);
        assert_eq!(coerce_category("grab"), Category::Transport);
        assert_eq!(coerce_category("sweldo"), Category::Income);
        assert_eq!(coerce_category("unknown"), Category::Other);
    }
}
