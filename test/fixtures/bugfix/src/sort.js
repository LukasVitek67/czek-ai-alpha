function compareBy(key) {
  if (key === 'duration') return (a, b) => b.duration - a.duration;
  if (key === 'year') return (a, b) => a.year - b.year;
  return (a, b) => a[key].localeCompare(b[key], 'cs');
}

module.exports = { compareBy };
