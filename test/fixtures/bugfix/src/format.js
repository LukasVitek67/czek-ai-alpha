function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s}`;
}

function totalDuration(tracks) {
  return formatDuration(tracks.reduce((sum, t) => sum + t.duration, 0));
}

module.exports = { formatDuration, totalDuration };
