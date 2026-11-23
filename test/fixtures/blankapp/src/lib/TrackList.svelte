<script>
  import { library } from './store.js';
  import { formatDuration, formatQuality } from './format.js';

  let tracks = $derived(
    library.tracks.filter((t) => t.title.toLowerCase().includes(library.filter.toLowerCase()))
  );
</script>

<input class="search" placeholder="Search" bind:value={library.filter} />
<table>
  <thead><tr><th>Title</th><th>Artist</th><th>Album</th><th>Quality</th><th>Time</th></tr></thead>
  <tbody>
    {#each tracks as track (track.id)}
      <tr>
        <td>{track.title}</td>
        <td>{track.artist}</td>
        <td>{track.album}</td>
        <td>{formatQuality(track)}</td>
        <td>{formatDuration(track.duration)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .search { margin-bottom: 12px; padding: 6px 8px; width: 240px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #222; }
</style>
