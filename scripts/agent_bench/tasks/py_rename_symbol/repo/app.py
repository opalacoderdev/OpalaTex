from pricing import core
from pricing.report import summary

CART = [{"price": 10.0, "qty": 2}, {"price": 2.5, "qty": 4}]

if __name__ == "__main__":
    print(summary(CART, 0.1))
    print("raw:", core.calc_total(CART))
