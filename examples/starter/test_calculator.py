import unittest

from calculator import add


class AdditionTests(unittest.TestCase):
    def test_positive_numbers(self):
        self.assertEqual(add(2, 3), 5)

    def test_negative_numbers(self):
        self.assertEqual(add(-2, -3), -5)

    def test_zero(self):
        self.assertEqual(add(4, 0), 4)

    def test_decimal_numbers(self):
        self.assertAlmostEqual(add(0.1, 0.2), 0.3)


if __name__ == '__main__':
    unittest.main()
