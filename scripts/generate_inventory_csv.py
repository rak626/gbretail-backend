#!/usr/bin/env python3
"""
Generate a sample CSV with ~1,000 grocery SKUs (400-500 products × 2-3 brands)
for GB Retail common inventory import.

Usage:
    python generate_inventory_csv.py [--products 400] [--brands 3] [--output sample_products.csv]
"""

import argparse
import csv
import random

CATEGORIES = [
    "Staples", "Dairy", "Beverages", "Snacks", "Produce", "Dairy",
    "Frozen", "Personal Care", "Household", "Spices", "Oils & Ghee",
    "Bakery", "Canned Foods", "Baby Care", "Pet Food"
]

UNITS = {
    "Staples": "kg",
    "Dairy": "pcs",
    "Beverages": "pcs",
    "Snacks": "pcs",
    "Produce": "kg",
    "Frozen": "pcs",
    "Personal Care": "pcs",
    "Household": "pcs",
    "Spices": "kg",
    "Oils & Ghee": "liters",
    "Bakery": "pcs",
    "Canned Foods": "pcs",
    "Baby Care": "pcs",
    "Pet Food": "kg",
}

BRANDS = ["FreshFarm", "DailyFresh", "PureNature", "GoldenGrain", "SunnySide"]

PRODUCT_TEMPLATES = {
    "Staples": ["Rice", "Wheat Flour", "Sugar", "Salt", "Lentils", "Pasta", "Oats", "Cornflakes", "Semolina", "Besan"],
    "Dairy": ["Milk", "Curd", "Paneer", "Butter", "Cheese", "Ghee", "Cream", "Buttermilk"],
    "Beverages": ["Tea", "Coffee", "Juice", "Soft Drink", "Mineral Water", "Energy Drink", "Milkshake"],
    "Snacks": ["Biscuits", "Chips", "Namkeen", "Chocolate", "Candy", "Popcorn", "Crackers"],
    "Produce": ["Potatoes", "Onions", "Tomatoes", "Apples", "Bananas", "Carrots", "Cabbage", "Spinach"],
    "Frozen": ["Frozen Peas", "Frozen Corn", "Frozen Fries", "Ice Cream", "Frozen Veg Mix"],
    "Personal Care": ["Soap", "Shampoo", "Toothpaste", "Detergent", "Face Wash", "Lotion"],
    "Household": ["Floor Cleaner", "Dish Wash", "Toilet Cleaner", "Mosquito Repellent", "Air Freshener"],
    "Spices": ["Turmeric", "Red Chili", "Coriander", "Cumin", "Garam Masala", "Black Pepper"],
    "Oils & Ghee": ["Cooking Oil", "Mustard Oil", "Coconut Oil", "Ghee", "Vanaspati"],
    "Bakery": ["Bread", "Buns", "Cake", "Cookies", "Muffins", "Patties"],
    "Canned Foods": ["Canned Beans", "Canned Corn", "Canned Soup", "Canned Fruits", "Canned Tuna"],
    "Baby Care": ["Baby Soap", "Baby Powder", "Diapers", "Baby Lotion", "Baby Wipes"],
    "Pet Food": ["Dog Food", "Cat Food", "Bird Seed", "Fish Food"],
}

def generate_products(num_products, num_brands):
    """Generate num_products products × num_brands brands = total SKUs."""
    brands = BRANDS[:num_brands]
    products = []
    sku_id = 1

    for category in CATEGORIES:
        templates = PRODUCT_TEMPLATES.get(category, [category])
        for template in templates:
            if len(products) >= num_products * num_brands:
                break
            for brand in brands:
                if len(products) >= num_products * num_brands:
                    break
                is_loose = category in ["Produce", "Staples", "Spices", "Oils & Ghee"]
                unit = UNITS.get(category, "pcs")

                # Base price varies by brand and category
                base_price = round(random.uniform(10, 500), 2)

                product = {
                    "id": sku_id,
                    "name": f"{template} - {brand}",
                    "category": category,
                    "brand": brand,
                    "barcode": f"890{sku_id:010d}",  # 13-digit barcode
                    "is_loose": is_loose,
                    "unit": unit,
                    "base_price": base_price,
                    "image_url": f"https://images.gbretail.com/{sku_id}.jpg",
                }
                products.append(product)
                sku_id += 1

    return products

def write_csv(products, output_file):
    """Write products to CSV file."""
    with open(output_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "name", "category", "brand", "barcode",
            "unit", "is_loose", "base_price", "image_url"
        ])
        for p in products:
            writer.writerow([
                p["name"],
                p["category"],
                p["brand"] or "",
                p["barcode"] or "",
                p["unit"],
                "true" if p["is_loose"] else "false",
                p["base_price"],
                p["image_url"],
            ])

def main():
    parser = argparse.ArgumentParser(description="Generate sample grocery inventory CSV")
    parser.add_argument("--products", type=int, default=400, help="Number of unique products (default: 400)")
    parser.add_argument("--brands", type=int, default=3, help="Number of brands per product (default: 3)")
    parser.add_argument("--output", default="sample_products.csv", help="Output CSV file (default: sample_products.csv)")
    args = parser.parse_args()

    total_skus = args.products * args.brands
    print(f"Generating {args.products} products × {args.brands} brands = {total_skus} SKUs...")

    products = generate_products(args.products, args.brands)
    write_csv(products, args.output)

    print(f"✓ Generated {len(products)} SKUs in {args.output}")
    print(f"  Categories: {len(CATEGORIES)}")
    print(f"  Brands: {', '.join(BRANDS[:args.brands])}")
    print("\nNext step: Import via API:")
    print("  curl -X POST http://localhost:4000/api/master-products/batch \\")
    print("    -H 'Content-Type: application/json' \\")
    print("    -H 'Authorization: Bearer <SUPER_ADMIN_TOKEN>' \\")
    print(f"    -d @{args.output}")

if __name__ == "__main__":
    main()
