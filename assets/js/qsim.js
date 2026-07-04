// A tiny quantum circuit composer + simulator (3 qubits, H/X/Z/CNOT), used by
// the "Run a quantum circuit" section. Everything runs locally in the browser:
// the circuit is simulated exactly on an 8-amplitude state vector, then sampled
// for 1024 shots — one per brick of the high-end model. Every run dispatches a
// 'quantego:pulse' event that the 3D viewers on the page react to.
//
// H, X, Z and CNOT all have real-valued matrices, so amplitudes stay real and
// the state fits in one Float64Array(8). Qubit i is bit i of the state index;
// ket labels read top wire first: |q0 q1 q2⟩.

const QUBITS = 3;
const COLS = 6;
const SHOTS = 1024;
const DIM = 1 << QUBITS;

const GATES = {
  H: { m: [ 1 / Math.SQRT2, 1 / Math.SQRT2, 1 / Math.SQRT2, - 1 / Math.SQRT2 ], label: 'H', hint: 'Hadamard — puts a qubit into an equal superposition of 0 and 1' },
  X: { m: [ 0, 1, 1, 0 ], label: 'X', hint: 'NOT — flips 0 to 1 and 1 to 0' },
  Z: { m: [ 1, 0, 0, - 1 ], label: 'Z', hint: 'Phase flip — leaves 0 alone, negates the amplitude of 1' },
  CX: { label: '●', hint: 'CNOT — flips the qubit below whenever this qubit is 1. This is what entangles qubits' },
};

const PRESETS = {
  'Coin flip': [ [ 0, 0, 'H' ] ],
  'Bell pair': [ [ 0, 0, 'H' ], [ 0, 1, 'CX' ] ],
  'GHZ state': [ [ 0, 0, 'H' ], [ 0, 1, 'CX' ], [ 1, 2, 'CX' ] ],
};

function applySingle( state, m, q ) {
  const bit = 1 << q;
  for ( let k = 0; k < DIM; k ++ ) {
    if ( k & bit ) continue;
    const a = state[ k ], b = state[ k | bit ];
    state[ k ] = m[ 0 ] * a + m[ 1 ] * b;
    state[ k | bit ] = m[ 2 ] * a + m[ 3 ] * b;
  }
}

function applyCX( state, c, t ) {
  const cb = 1 << c, tb = 1 << t;
  for ( let k = 0; k < DIM; k ++ ) {
    if ( ( k & cb ) && ! ( k & tb ) ) {
      const j = k | tb;
      const tmp = state[ k ];
      state[ k ] = state[ j ];
      state[ j ] = tmp;
    }
  }
}

function simulate( circuit ) {
  const state = new Float64Array( DIM );
  state[ 0 ] = 1;
  for ( let col = 0; col < COLS; col ++ ) {
    for ( let q = 0; q < QUBITS; q ++ ) {
      const cell = circuit[ q ][ col ];
      if ( ! cell || cell === 'CXT' ) continue;
      if ( cell === 'CX' ) applyCX( state, q, q + 1 );
      else applySingle( state, GATES[ cell ].m, q );
    }
  }
  return state;
}

function sample( state ) {
  const probs = [ ...state ].map( a => a * a );
  const counts = new Array( DIM ).fill( 0 );
  for ( let s = 0; s < SHOTS; s ++ ) {
    let r = Math.random(), k = 0;
    while ( k < DIM - 1 && r >= probs[ k ] ) { r -= probs[ k ]; k ++; }
    counts[ k ] ++;
  }
  return counts;
}

function ket( k ) {
  let s = '';
  for ( let q = 0; q < QUBITS; q ++ ) s += ( k >> q ) & 1;
  return s;
}

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
  // circuit[q][col] = null | 'H' | 'X' | 'Z' | 'CX' (control) | 'CXT' (target)
  const circuit = Array.from( { length: QUBITS }, () => new Array( COLS ).fill( null ) );
  let tool = 'H';
  const cells = []; // cells[q][col] -> button

  // --- toolbar: gate palette + presets -------------------------------------
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
  for ( const [ name, gates ] of Object.entries( PRESETS ) ) {
    presets.appendChild( btn( 'qsim-preset', name, () => loadPreset( gates ) ) );
  }
  presets.appendChild( btn( 'qsim-preset', 'Clear', () => loadPreset( [] ) ) );

  function setTool( t ) {
    tool = t;
    for ( const [ k, b ] of Object.entries( toolBtns ) ) b.classList.toggle( 'is-active', k === t );
  }

  // --- circuit grid ---------------------------------------------------------
  const grid = el( 'div', 'qsim-grid' );
  grid.setAttribute( 'role', 'grid' );
  for ( let q = 0; q < QUBITS; q ++ ) {
    const row = el( 'div', 'qsim-wire' );
    row.appendChild( el( 'span', 'qsim-wirelabel', `q${q}` ) );
    cells[ q ] = [];
    for ( let col = 0; col < COLS; col ++ ) {
      const c = btn( 'qsim-cell', '', () => onCell( q, col ) );
      c.setAttribute( 'aria-label', `qubit ${q}, column ${col + 1}` );
      cells[ q ][ col ] = c;
      row.appendChild( c );
    }
    grid.appendChild( row );
  }

  // Removes whatever occupies (q, col), including a CNOT's other half.
  function clearCell( q, col ) {
    const v = circuit[ q ][ col ];
    if ( v === 'CX' && q + 1 < QUBITS && circuit[ q + 1 ][ col ] === 'CXT' ) circuit[ q + 1 ][ col ] = null;
    if ( v === 'CXT' && q > 0 && circuit[ q - 1 ][ col ] === 'CX' ) circuit[ q - 1 ][ col ] = null;
    circuit[ q ][ col ] = null;
  }

  function onCell( q, col ) {
    const cur = circuit[ q ][ col ];
    if ( tool === 'ERASE' ) {
      clearCell( q, col );
    } else if ( tool === 'CX' ) {
      const control = q < QUBITS - 1 ? q : q - 1; // bottom wire: place upward
      if ( circuit[ control ][ col ] === 'CX' ) {
        clearCell( control, col );
      } else {
        clearCell( control, col );
        clearCell( control + 1, col );
        circuit[ control ][ col ] = 'CX';
        circuit[ control + 1 ][ col ] = 'CXT';
      }
    } else {
      clearCell( q, col );
      if ( cur !== tool ) circuit[ q ][ col ] = tool;
    }
    paint();
  }

  function loadPreset( gates ) {
    for ( let q = 0; q < QUBITS; q ++ ) circuit[ q ].fill( null );
    for ( const [ q, col, g ] of gates ) {
      circuit[ q ][ col ] = g;
      if ( g === 'CX' ) circuit[ q + 1 ][ col ] = 'CXT';
    }
    paint();
  }

  function paint() {
    for ( let q = 0; q < QUBITS; q ++ ) {
      for ( let col = 0; col < COLS; col ++ ) {
        const v = circuit[ q ][ col ];
        const c = cells[ q ][ col ];
        c.textContent = v === 'CX' ? '●' : v === 'CXT' ? '⊕' : v || '';
        c.classList.toggle( 'has-gate', !! v );
        c.classList.toggle( 'is-cx-control', v === 'CX' );
        c.classList.toggle( 'is-cx-target', v === 'CXT' );
      }
    }
  }

  // --- run + histogram -------------------------------------------------------
  const run = btn( 'qsim-run', `▶ Run ${SHOTS} shots`, () => {
    const counts = sample( simulate( circuit ) );
    renderResults( counts );
    window.dispatchEvent( new CustomEvent( 'quantego:pulse' ) );
  } );
  run.title = `Simulate the circuit and measure all ${QUBITS} qubits, ${SHOTS} times`;

  const results = el( 'div', 'qsim-results' );

  function renderResults( counts ) {
    results.innerHTML = '';
    const max = Math.max( ...counts, 1 );
    results.appendChild( el( 'div', 'qsim-results-title', `Measurement results — ${SHOTS} shots (one per brick of the 1024-brick model)` ) );
    counts.forEach( ( n, k ) => {
      const row = el( 'div', 'qsim-bar-row' );
      const pct = ( n / SHOTS * 100 ).toFixed( 1 );
      row.title = `|${ket( k )}⟩: ${n} of ${SHOTS} shots (${pct}%)`;
      row.appendChild( el( 'span', 'qsim-bar-ket', `|${ket( k )}⟩` ) );
      const track = el( 'div', 'qsim-bar-track' );
      const bar = el( 'div', 'qsim-bar' );
      bar.style.width = ( n / max * 100 ) + '%';
      track.appendChild( bar );
      row.appendChild( track );
      row.appendChild( el( 'span', 'qsim-bar-count', String( n ) ) );
      results.appendChild( row );
    } );
    results.appendChild( el( 'div', 'qsim-note', 'Simulated locally in your browser — watch the LEGO models above light up on every run.' ) );
  }

  container.append( palette, presets, grid, run, results );
  setTool( 'H' );
  loadPreset( PRESETS[ 'Bell pair' ] );
}

export function initAll() {
  document.querySelectorAll( '.qsim' ).forEach( createSim );
}
