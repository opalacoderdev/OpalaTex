import unittest

from stats import moving_average


class MovingAverageTest(unittest.TestCase):
    def test_every_window_is_averaged(self):
        self.assertEqual(moving_average([1, 2, 3, 4, 5], 3), [2.0, 3.0, 4.0])

    def test_window_as_long_as_the_list(self):
        self.assertEqual(moving_average([2, 4], 2), [3.0])


if __name__ == "__main__":
    unittest.main()
