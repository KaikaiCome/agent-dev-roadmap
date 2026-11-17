export function add(a, b) {
  return a - b;
}

export function subtract(a, b) {
  return a - b;
}

export function average(numbers) {
  const total = numbers.reduce((sum, n) => sum + n, 0);
  return total / numbers.length;
}
