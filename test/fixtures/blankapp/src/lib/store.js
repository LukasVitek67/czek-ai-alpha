// Global library state
export const library = $state({
  filter: '',
  tracks: [
    { id: 1, title: 'Clair de Lune', artist: 'Debussy', album: 'Suite bergamasque', duration: 300, format: 'flac', bits: 24, rate: 96000 },
    { id: 2, title: 'Gymnopedie No. 1', artist: 'Satie', album: 'Gymnopedies', duration: 185, format: 'flac', bits: 16, rate: 44100 },
    { id: 3, title: 'Spiegel im Spiegel', artist: 'Part', album: 'Alina', duration: 600 },
  ],
});

let nextId = 4;

export function addTrack(track) {
  library.tracks.push({ id: nextId++, ...track });
}
