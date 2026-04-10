describe('token weighting parity vectors', () => {
  const vectors = [
    { cacheRead: 0, expected: 0 },
    { cacheRead: 1, expected: 0 },
    { cacheRead: 4, expected: 0 },
    { cacheRead: 5, expected: 1 },
    { cacheRead: 9, expected: 1 },
    { cacheRead: 10, expected: 1 },
    { cacheRead: 15, expected: 2 },
    { cacheRead: 101, expected: 10 },
    { cacheRead: 200, expected: 20 },
    { cacheRead: 999, expected: 100 },
  ];

  test.each(vectors)('cacheRead=$cacheRead -> weighted=$expected', ({ cacheRead, expected }) => {
    const jsWeighted = Math.round(cacheRead * 0.1);
    const rustWeighted = Math.floor((cacheRead + 5) / 10);
    expect(jsWeighted).toBe(expected);
    expect(rustWeighted).toBe(expected);
    expect(jsWeighted).toBe(rustWeighted);
  });
});
