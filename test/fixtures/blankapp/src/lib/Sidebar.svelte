<script>
  import { library, addTrack } from './store.js';

  let count = $derived(library.tracks.length);
</script>

<aside>
  <div class="brand">Tunes</div>
  <nav>
    <span class="nav-item">Library ({count})</span>
    <button class="nav-item" onclick={addFolder}>Add Music Folder</button>
  </nav>
</aside>

<style>
  aside { width: 200px; background: #111; padding: 16px; }
  .brand { font-weight: 700; margin-bottom: 16px; }
  .nav-item { display: block; padding: 6px 0; background: none; border: 0; color: inherit; text-align: left; cursor: pointer; }
</style>
