// Food categories have localized labels for the catalog. All categories have classifier guidance.
const definitions = {
  meat: {
    names: { de: "Fleisch & Wurst", en: "Meat", "zh-TW": "肉類" },
    description: "fresh and processed meat and poultry, sausages, ham, salami, cold cuts, meat substitutes",
  },
  seafood: {
    names: { de: "Fisch & Meeresfrüchte", en: "Fish & seafood", "zh-TW": "海鮮" },
    description: "fish and seafood, fresh, smoked or frozen (not ready meals like fish fingers)",
  },
  vegetables: {
    names: { de: "Gemüse", en: "Vegetables", "zh-TW": "蔬菜" },
    description: "fresh vegetables, potatoes, salad, fresh herbs, mushrooms",
  },
  fruits: {
    names: { de: "Obst", en: "Fruit", "zh-TW": "水果" },
    description: "fresh fruit",
  },
  eggs: {
    names: { de: "Eier", en: "Eggs", "zh-TW": "蛋" },
    description: "eggs",
  },
  bread: {
    names: { de: "Brot & Backwaren", en: "Bread & bakery", "zh-TW": "麵包烘焙" },
    description: "bread, rolls, baked goods and cakes from the bakery, bake-off products",
  },
  dairy: {
    names: { de: "Milchprodukte", en: "Dairy", "zh-TW": "乳製品" },
    description: "milk, yogurt, quark, cheese, butter, cream, dairy desserts, margarine, plant-based milk and yogurt alternatives",
  },
  sweets_snacks: {
    names: { de: "Süßes & Snacks", en: "Sweets & snacks", "zh-TW": "零食甜點" },
    description: "chocolate, candy, biscuits, Christmas sweets, crisps, salty snacks, nuts, ice cream, packaged cakes",
  },
  pantry: {
    names: { de: "Vorrat", en: "Pantry", "zh-TW": "乾貨調味" },
    description: "pasta, rice, flour, sugar, baking ingredients, oil, vinegar, sauces, spices, canned and jarred food, jam, honey, spreads, cereals",
  },
  instant_food: {
    names: { de: "Fertiggerichte", en: "Ready meals", "zh-TW": "即食料理" },
    description: "ready meals, frozen pizza and meals, fresh pasta meals, fries, fish fingers, instant noodles and soups",
  },
  drinks: {
    names: { de: "Getränke", en: "Drinks", "zh-TW": "飲料" },
    description: "non-alcoholic drinks: water, juice, soft drinks, coffee, tea, cocoa; also alcohol-free beer and alcohol-free wine",
  },
  other: {
    names: { de: "Sonstiges", en: "Other", "zh-TW": "其他" },
    description: "food or drink that fits none of the above",
  },
  alcohol: {
    names: null,
    description: "beer, wine, sparkling wine, spirits, liqueur, and other drinks with alcohol (alcohol-free beer and wine are \"drinks\"; food that merely contains alcohol, like rum pralines, is food)",
  },
  pet_food: {
    names: null,
    description: "food and treats for pets",
  },
  non_food: {
    names: null,
    description: "everything else: household, cleaning, drugstore, cosmetics, clothing, appliances, toys, plants and flowers, gift cards, travel",
  },
};

export const CATEGORIES = Object.keys(definitions);
export const FOOD_CATEGORIES = CATEGORIES.filter(key => definitions[key].names !== null);
export const DROPPED = CATEGORIES.filter(key => definitions[key].names === null);
export const CATEGORY_NAMES = Object.fromEntries(FOOD_CATEGORIES.map(key => [key, definitions[key].names]));

function describe(keys) {
  return keys.map(key => `- ${key}: ${definitions[key].description}`).join("\n");
}

export const CATEGORY_GUIDANCE = `Categories for food and drinks (pick the one that fits best):
${describe(FOOD_CATEGORIES)}

Not food (these products are dropped and not translated):
${describe(DROPPED)}
`;
