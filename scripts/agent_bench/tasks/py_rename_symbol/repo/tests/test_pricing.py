import unittest

from pricing.core import calc_total
from pricing.report import summary


class PricingTest(unittest.TestCase):
    def test_total_with_tax(self):
        self.assertEqual(calc_total([{"price": 10.0, "qty": 2}], 0.1), 22.0)

    def test_summary(self):
        self.assertEqual(summary([{"price": 1.0, "qty": 3}]), "1 items, total 3.00")


if __name__ == "__main__":
    unittest.main()
