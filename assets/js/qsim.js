// A tiny quantum circuit composer + simulator (1-3 qubits, H/X/Z/CNOT), used
// by the "Run a quantum circuit" section. Everything runs locally in the
// browser: the circuit is simulated exactly on a 2^n-amplitude state vector,
// then sampled for 1024 shots — one per brick of the high-end model. Every run
// dispatches a 'quantego:pulse' event that the 3D viewers on the page react to.
//
// H, X, Z and CNOT all have real-valued matrices, so amplitudes stay real and
// the state fits in one small Float64Array. Qubit i is bit i of the state
// index; ket labels are little-endian as on IBM Quantum / Qiskit: |q2 q1 q0⟩,
// so the top wire q0 is the rightmost bit.

const MAX_QUBITS = 3;
const COLS = 6;
const SHOTS = 1024;

const GATES = {
  H: { m: [ 1 / Math.SQRT2, 1 / Math.SQRT2, 1 / Math.SQRT2, - 1 / Math.SQRT2 ], hint: 'Hadamard — puts a qubit into an equal superposition of 0 and 1' },
  X: { m: [ 0, 1, 1, 0 ], hint: 'NOT — flips 0 to 1 and 1 to 0' },
  Z: { m: [ 1, 0, 0, - 1 ], hint: 'Phase flip — leaves 0 alone, negates the amplitude of 1' },
  CX: { hint: 'CNOT (controlled-NOT) — flips the target ⊕ whenever the control ● is 1. This is what entangles qubits' },
};

// Preset circuits: singles are { g, q, col }, CNOTs are { g: 'CX', c, t, col }.
// min is the smallest qubit count the preset fits on — picking a preset
// switches the simulator to (at least) that many qubits.
const PRESETS = {
  'Coin flip': {
    min: 1,
    desc: 'A single H gate makes a fair quantum coin: every shot lands 0 or 1, each with 50%.',
    ops: [ { g: 'H', q: 0, col: 0 } ],
  },
  'Bell pair': {
    min: 2,
    desc: 'H plus CNOT entangles two qubits: about half the shots read 00 and half 11 — the qubits always agree.',
    ops: [ { g: 'H', q: 0, col: 0 }, { g: 'CX', c: 0, t: 1, col: 1 } ],
  },
  'GHZ state': {
    min: 3,
    desc: 'Three qubits entangled at once: every shot reads 000 or 111, never anything in between.',
    ops: [ { g: 'H', q: 0, col: 0 }, { g: 'CX', c: 0, t: 1, col: 1 }, { g: 'CX', c: 1, t: 2, col: 2 } ],
  },
};

function applySingle( state, m, q ) {
  const bit = 1 << q;
  for ( let k = 0; k < state.length; k ++ ) {
    if ( k & bit ) continue;
    const a = state[ k ], b = state[ k | bit ];
    state[ k ] = m[ 0 ] * a + m[ 1 ] * b;
    state[ k | bit ] = m[ 2 ] * a + m[ 3 ] * b;
  }
}

function applyCX( state, c, t ) {
  const cb = 1 << c, tb = 1 << t;
  for ( let k = 0; k < state.length; k ++ ) {
    if ( ( k & cb ) && ! ( k & tb ) ) {
      const j = k | tb;
      const tmp = state[ k ];
      state[ k ] = state[ j ];
      state[ j ] = tmp;
    }
  }
}

// circuit[q][col] holds 'H' | 'X' | 'Z' | null for single-qubit gates, or the
// pieces of a CNOT: 'CX' (control), 'CXT' (target), 'CXL' (a wire the CNOT's
// connector line crosses — kept occupied so nothing else lands under the line).
function simulate( circuit, qubits ) {
  const state = new Float64Array( 1 << qubits );
  state[ 0 ] = 1;
  for ( let col = 0; col < COLS; col ++ ) {
    let c = - 1, t = - 1;
    for ( let q = 0; q < qubits; q ++ ) {
      const cell = circuit[ q ][ col ];
      if ( cell === 'CX' ) c = q;
      else if ( cell === 'CXT' ) t = q;
      else if ( cell && cell !== 'CXL' ) applySingle( state, GATES[ cell ].m, q );
    }
    if ( c >= 0 && t >= 0 ) applyCX( state, c, t );
  }
  return state;
}

function sample( state ) {
  const probs = [ ...state ].map( a => a * a );
  const counts = new Array( state.length ).fill( 0 );
  for ( let s = 0; s < SHOTS; s ++ ) {
    let r = Math.random(), k = 0;
    while ( k < counts.length - 1 && r >= probs[ k ] ) { r -= probs[ k ]; k ++; }
    counts[ k ] ++;
  }
  return counts;
}

// Little-endian ket label: highest qubit first, q0 as the rightmost bit.
function ket( k, qubits ) {
  let s = '';
  for ( let q = qubits - 1; q >= 0; q -- ) s += ( k >> q ) & 1;
  return s;
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
function wireName( q ) { return 'q' + SUB[ q ]; }

function el( tag, cls, text ) {
  const e = document.createElement( tag );
  if ( cls ) e.className = cls;
  if ( text !== undefined ) e.textContent = text;
  return e;
}

function btn( cls, text, onClick ) {
  const b = el( 'button', cls, text );
  b.type = 'button';
  b.addEventListener( 'click', onClick );
  return b;
}

function createSim( container ) {
  let qubits = MAX_QUBITS;
  let circuit = [];
  let cells = []; // cells[q][col] -> button
  let tool = 'H';
  let pending = null; // { q, col } — a CNOT control waiting for its target

  // --- toolbar: qubit count + gate palette + presets -------------------------
  const qubitRow = el( 'div', 'qsim-row' );
  qubitRow.appendChild( el( 'span', 'qsim-rowlabel', 'Qubits' ) );
  const qubitBtns = {};
  for ( let n = 1; n <= MAX_QUBITS; n ++ ) {
    const b = btn( 'qsim-tool qsim-qubit', String( n ), () => setQubits( n ) );
    b.title = `Use ${n} qubit${n > 1 ? 's' : ''}`;
    qubitBtns[ n ] = b;
    qubitRow.appendChild( b );
  }

  const palette = el( 'div', 'qsim-row' );
  palette.appendChild( el( 'span', 'qsim-rowlabel', 'Gates' ) );
  const toolBtns = {};
  for ( const g of [ 'H', 'X', 'Z', 'CX' ] ) {
    const b = btn( 'qsim-tool', g === 'CX' ? '● CX' : g, () => setTool( g ) );
    b.title = GATES[ g ].hint;
    toolBtns[ g ] = b;
    palette.appendChild( b );
  }
  const eraser = btn( 'qsim-tool', '⌫', () => setTool( 'ERASE' ) );
  eraser.title = 'Eraser — remove a gate';
  toolBtns.ERASE = eraser;
  palette.appendChild( eraser );

  const presets = el( 'div', 'qsim-row' );
  presets.appendChild( el( 'span', 'qsim-rowlabel', 'Presets' ) );
  for ( const [ name, p ] of Object.entries( PRESETS ) ) {
    const b = btn( 'qsim-preset', name, () => usePreset( name ) );
    b.title = p.desc;
    presets.appendChild( b );
  }
  presets.appendChild( btn( 'qsim-preset', 'Clear', () => loadPreset( [] ) ) );

  // Presets work from any qubit count: one that needs more qubits than are
  // selected simply switches the simulator up to fit.
  function usePreset( name ) {
    const p = PRESETS[ name ];
    if ( p.min > qubits ) setQubits( p.min, p.ops );
    else loadPreset( p.ops );
    hint.textContent = `${name} — ${p.desc}`;
  }

  function setTool( t ) {
    tool = t;
    pending = null;
    for ( const [ k, b ] of Object.entries( toolBtns ) ) b.classList.toggle( 'is-active', k === t );
    paint();
  }

  // --- circuit grid ---------------------------------------------------------
  const grid = el( 'div', 'qsim-grid' );
  grid.setAttribute( 'role', 'grid' );

  function buildGrid() {
    grid.innerHTML = '';
    cells = [];
    circuit = Array.from( { length: qubits }, () => new Array( COLS ).fill( null ) );
    for ( let q = 0; q < qubits; q ++ ) {
      const row = el( 'div', 'qsim-wire' );
      row.appendChild( el( 'span', 'qsim-wirelabel', wireName( q ) ) );
      cells[ q ] = [];
      for ( let col = 0; col < COLS; col ++ ) {
        const c = btn( 'qsim-cell', '', () => onCell( q, col ) );
        c.setAttribute( 'aria-label', `qubit ${q}, column ${col + 1}` );
        cells[ q ][ col ] = c;
        row.appendChild( c );
      }
      grid.appendChild( row );
    }
  }

  function setQubits( n, ops ) {
    qubits = n;
    pending = null;
    for ( const [ k, b ] of Object.entries( qubitBtns ) ) b.classList.toggle( 'is-active', + k === n );
    buildGrid();
    // A CNOT needs two wires.
    toolBtns.CX.disabled = n < 2;
    if ( n < 2 && tool === 'CX' ) { setTool( 'H' ); }
    results.innerHTML = '';
    loadPreset( ops || ( n === 1 ? PRESETS[ 'Coin flip' ] : PRESETS[ 'Bell pair' ] ).ops );
  }

  // One-line helper text under the grid; doubles as the CNOT placement prompt
  // (title tooltips don't exist on touch screens).
  const hint = el( 'div', 'qsim-hint' );

  // Removes whatever occupies (q, col). Any piece of a CNOT removes the whole
  // CNOT — control, target and crossed wires alike.
  function clearCell( q, col ) {
    const v = circuit[ q ][ col ];
    if ( v === 'CX' || v === 'CXT' || v === 'CXL' ) {
      for ( let i = 0; i < qubits; i ++ ) {
        const w = circuit[ i ][ col ];
        if ( w === 'CX' || w === 'CXT' || w === 'CXL' ) circuit[ i ][ col ] = null;
      }
    } else {
      circuit[ q ][ col ] = null;
    }
  }

  function placeCX( c, t, col ) {
    // A column holds at most one CNOT: drop any existing one, then claim the
    // whole control-to-target span (overwriting any single gates on the way).
    for ( let i = 0; i < qubits; i ++ ) {
      const w = circuit[ i ][ col ];
      if ( w === 'CX' || w === 'CXT' || w === 'CXL' ) circuit[ i ][ col ] = null;
    }
    for ( let i = Math.min( c, t ); i <= Math.max( c, t ); i ++ ) circuit[ i ][ col ] = 'CXL';
    circuit[ c ][ col ] = 'CX';
    circuit[ t ][ col ] = 'CXT';
  }

  function onCell( q, col ) {
    if ( tool === 'CX' ) {
      const v = circuit[ q ][ col ];
      if ( pending && pending.col === col && pending.q === q ) {
        pending = null; // tapping the pending control again cancels it
      } else if ( pending && pending.col === col ) {
        const control = pending.q;
        pending = null;
        placeCX( control, q, col );
      } else if ( v === 'CX' || v === 'CXT' || v === 'CXL' ) {
        pending = null;
        clearCell( q, col ); // tap an existing CNOT to remove it
      } else {
        pending = { q, col }; // first click: place the control
      }
    } else if ( tool === 'ERASE' ) {
      pending = null;
      clearCell( q, col );
    } else {
      pending = null;
      const cur = circuit[ q ][ col ];
      clearCell( q, col );
      if ( cur !== tool ) circuit[ q ][ col ] = tool;
    }
    paint();
  }

  function loadPreset( ops ) {
    pending = null;
    for ( let q = 0; q < qubits; q ++ ) circuit[ q ].fill( null );
    for ( const op of ops ) {
      if ( op.g === 'CX' ) placeCX( op.c, op.t, op.col );
      else circuit[ op.q ][ op.col ] = op.g;
    }
    paint();
  }

  function hintText() {
    if ( tool === 'CX' ) {
      return pending
        ? `Control on ${wireName( pending.q )} — now click the target qubit in the same column (click ● again to cancel).`
        : 'CNOT (controlled-NOT) flips the target ⊕ whenever the control ● is 1 — the gate that entangles qubits. Click a cell to place the control ●, then the target ⊕ in the same column.';
    }
    if ( tool === 'ERASE' ) return 'Click a gate to remove it.';
    return GATES[ tool ].hint + '.';
  }

  function paint() {
    if ( ! cells.length ) return; // grid not built yet
    for ( let col = 0; col < COLS; col ++ ) {
      let c = - 1, t = - 1;
      for ( let q = 0; q < qubits; q ++ ) {
        if ( circuit[ q ][ col ] === 'CX' ) c = q;
        else if ( circuit[ q ][ col ] === 'CXT' ) t = q;
      }
      const lo = Math.min( c, t ), hi = Math.max( c, t );
      for ( let q = 0; q < qubits; q ++ ) {
        const v = circuit[ q ][ col ];
        const cell = cells[ q ][ col ];
        const isPend = pending && pending.q === q && pending.col === col;
        cell.textContent = isPend || v === 'CX' ? '●' : v === 'CXT' ? '⊕' : v === 'CXL' ? '' : v || '';
        cell.classList.toggle( 'has-gate', !! v && v !== 'CXL' );
        cell.classList.toggle( 'is-cx-target', v === 'CXT' );
        cell.classList.toggle( 'is-cx-pending', !! isPend );
        // Vertical connector: down from every span cell above the bottom end,
        // up into every span cell below the top end (control can be either end).
        const inSpan = c >= 0 && t >= 0 && q >= lo && q <= hi;
        cell.classList.toggle( 'cx-down', inSpan && q < hi );
        cell.classList.toggle( 'cx-up', inSpan && q > lo );
      }
    }
    hint.textContent = hintText();
  }

  // --- run + histogram -------------------------------------------------------
  const run = btn( 'qsim-run', `▶ Run ${SHOTS} shots`, () => {
    const counts = sample( simulate( circuit, qubits ) );
    renderResults( counts );
    // Local feedback (the panel itself glows) plus the page-wide pulse the
    // 3D viewers react to.
    container.classList.remove( 'is-pulsing' );
    void container.offsetWidth; // restart the CSS animation
    container.classList.add( 'is-pulsing' );
    window.dispatchEvent( new CustomEvent( 'quantego:pulse' ) );
  } );
  run.title = `Simulate the circuit and measure all qubits, ${SHOTS} times`;

  const results = el( 'div', 'qsim-results' );

  function renderResults( counts ) {
    results.innerHTML = '';
    const max = Math.max( ...counts, 1 );
    results.appendChild( el( 'div', 'qsim-results-title', `Measurement results — ${SHOTS} shots (one per brick of the 1024-brick model further down)` ) );
    counts.forEach( ( n, k ) => {
      const row = el( 'div', 'qsim-bar-row' );
      const pct = ( n / SHOTS * 100 ).toFixed( 1 );
      row.title = `|${ket( k, qubits )}⟩: ${n} of ${SHOTS} shots (${pct}%)`;
      row.appendChild( el( 'span', 'qsim-bar-ket', `|${ket( k, qubits )}⟩` ) );
      const track = el( 'div', 'qsim-bar-track' );
      const bar = el( 'div', 'qsim-bar' );
      bar.style.width = ( n / max * 100 ) + '%';
      track.appendChild( bar );
      row.appendChild( track );
      row.appendChild( el( 'span', 'qsim-bar-count', String( n ) ) );
      results.appendChild( row );
    } );
    if ( qubits > 1 ) {
      let names = '';
      for ( let q = qubits - 1; q >= 0; q -- ) names += wireName( q );
      results.appendChild( el( 'div', 'qsim-note', `Kets are little-endian, as on IBM Quantum: |${names}⟩ — the top wire ${wireName( 0 )} is the rightmost bit.` ) );
    }
    results.appendChild( el( 'div', 'qsim-note', 'Simulated locally in your browser. Each run also flashes the golden chandelier inside the cryostat above — in the real machine, that is where the qubits live.' ) );
  }

  container.append( qubitRow, palette, presets, grid, hint, run, results );
  setQubits( MAX_QUBITS );
  setTool( 'H' );
}

export function initAll() {
  document.querySelectorAll( '.qsim' ).forEach( createSim );
}
