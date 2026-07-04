import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';

// <model-viewer> powers "view in your room" AR. It's only pulled in the first
// time a user opens AR, so the homepage never pays for it up front.
let modelViewerPromise = null;
function ensureModelViewer() {
  return modelViewerPromise ||
    ( modelViewerPromise = import( 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js' ) );
}

function viewerButton( label, onClick ) {
  const btn = document.createElement( 'button' );
  btn.type = 'button';
  btn.className = 'viewer-btn';
  btn.textContent = label;
  btn.addEventListener( 'click', onClick );
  return btn;
}

// Building step of an object = step of its nearest ancestor that carries one.
function buildingStepOf( obj ) {
  for ( let n = obj; n; n = n.parent ) {
    if ( n.userData && n.userData.buildingStep !== undefined ) return n.userData.buildingStep;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// MPD metadata. The packed .mpd files Studio exports carry everything we need
// for part identification and step captions as plain text: `0 !COLOUR` rows
// (name + hex per colour code), a description line after each `0 FILE x.dat`
// part block, and `0 STUDIOSTEPDESC` captions in the main model. One extra
// fetch per model; the browser serves it from cache since the loader just
// downloaded the same URL.

const metaCache = new Map();

function loadMeta( url ) {
  if ( ! metaCache.has( url ) ) {
    metaCache.set( url, fetch( url )
      .then( r => r.ok ? r.text() : '' )
      .then( parseMeta )
      .catch( () => parseMeta( '' ) ) );
  }
  return metaCache.get( url );
}

function parseMeta( text ) {
  const colors = {}; // colour code -> { name, hex }
  const parts = {}; // lowercased basename ("3001.dat") -> description
  const captions = []; // main-model step index -> Studio step description
  const lines = text.split( '\n' );

  let inMain = true; // the main model is the implicit block before the first 0 FILE
  let awaitDesc = null; // part file waiting for its description line
  let spanDesc = null; // first STUDIOSTEPDESC seen in the current step span
  let spanHasBricks = false;

  for ( let raw of lines ) {
    const line = raw.trim();
    const m = line.match( /^0 !COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#[0-9A-Fa-f]{6})/ );
    if ( m ) { colors[ m[ 2 ] ] = { name: m[ 1 ].replace( /_/g, ' ' ), hex: m[ 3 ] }; continue; }

    if ( line.startsWith( '0 FILE ' ) ) {
      inMain = false;
      const f = line.slice( 7 ).trim().toLowerCase();
      awaitDesc = /\.dat$/.test( f ) ? f.split( '/' ).pop() : null;
      continue;
    }
    if ( awaitDesc && line.startsWith( '0 ' ) ) {
      const desc = line.slice( 2 ).trim();
      if ( desc && ! desc.startsWith( '!' ) && ! /^(Name|Author):/i.test( desc ) ) parts[ awaitDesc ] = desc.replace( / {2,}/g, ' ' );
      awaitDesc = null;
      continue;
    }

    if ( ! inMain ) continue;
    if ( line.startsWith( '0 STUDIOSTEPDESC ' ) ) {
      if ( spanDesc === null ) spanDesc = line.slice( 17 ).trim();
    } else if ( /^0 STEP\s*$/.test( line ) ) {
      captions.push( spanDesc );
      spanDesc = null;
      spanHasBricks = false;
    } else if ( line.startsWith( '1 ' ) ) {
      spanHasBricks = true;
    }
  }
  if ( spanHasBricks || spanDesc !== null ) captions.push( spanDesc ); // trailing step with no 0 STEP terminator

  return { colors, parts, captions };
}

function titleCase( s ) {
  return s.replace( /\w\S*/g, w => w[ 0 ].toUpperCase() + w.slice( 1 ) );
}

// ---------------------------------------------------------------------------
// Deep links: #v=<model>&cp=<camera>&ct=<target>&s=<step> restores a shared
// viewpoint (and optionally a build step) in the matching viewer.

function parseShareHash() {
  const h = location.hash.replace( /^#/, '' );
  if ( ! h.includes( 'v=' ) ) return null;
  const q = new URLSearchParams( h );
  const vec = s => {
    const a = ( s || '' ).split( ',' ).map( Number );
    return a.length === 3 && a.every( isFinite ) ? a : null;
  };
  const out = { v: q.get( 'v' ), cp: vec( q.get( 'cp' ) ), ct: vec( q.get( 'ct' ) ) };
  const s = q.get( 's' );
  out.s = s !== null && isFinite( + s ) ? + s : null;
  return out.v ? out : null;
}

const pendingShare = parseShareHash();

// ---------------------------------------------------------------------------
// "Anatomy of a quantum computer" tour content, keyed by model slug (the .mpd
// basename). Anchors resolve against the loaded model: `group` matches a named
// Studio submodel, `stepDesc` matches a Studio step caption (System One has no
// submodels), and `at` is a fallback position in normalised bounding-box
// coordinates [x, y, z] with y = 0 at the ground.

const ANATOMY = {
  'quantego-one': [
    { title: 'Glass enclosure', at: [ 0.04, 0.62, 0.5 ], body: 'The real IBM Quantum System One lives in a 2.7 m cube of half-inch borosilicate glass — an airtight case that isolates the machine from vibration and temperature swings while letting visitors admire it.' },
    { title: 'Cryostat', at: [ 0.5, 0.55, 0.5 ], body: 'The central cylinder is the cryostat: a dilution refrigerator that chills the hardware to about 15 millikelvin — colder than outer space — so the fragile quantum states of the qubits survive.' },
    { title: 'Quantum processor', at: [ 0.5, 0.3, 0.5 ], body: 'At the very bottom of the cryostat hangs the quantum chip itself, smaller than a coin. The first System One carried a 20-qubit processor; later systems host 27-qubit Falcon and 127-qubit Eagle chips.' },
    { title: 'Control rack', stepDesc: 'Rack', at: [ 0.85, 0.4, 0.15 ], body: 'The racks hold the classical control electronics: they fire precisely timed microwave pulses at the qubits to run a circuit, then read the answers back out.' },
  ],
  'quantego-two': [
    { title: 'Modular walls', group: 'wall', at: [ 0.1, 0.55, 0.5 ], body: 'IBM Quantum System Two is modular: instead of one sealed glass cube, standardised units can be combined, serviced and extended — a design made to grow.' },
    { title: 'Cryostat', group: 'cryostat', at: [ 0.5, 0.5, 0.5 ], body: 'A larger cryogenic platform that can host multiple quantum processors side by side — the first System Two runs IBM Quantum Heron chips.' },
    { title: 'Control electronics', group: 'rack', at: [ 0.85, 0.35, 0.5 ], body: 'Third-generation control electronics orchestrate microwave pulses across all processors in the system and stream the results to classical computers.' },
    { title: 'Quantum-centric supercomputing', at: [ 0.5, 0.95, 0.5 ], body: 'System Two is designed to be linked with classical supercomputers — and with other System Twos — into what IBM calls a quantum-centric supercomputer.' },
  ],
  'quantego-two-1024': [
    { title: 'Base and floor', group: 'base', at: [ 0.5, 0.05, 0.5 ], body: 'The raised floor hides cabling, cooling and vibration isolation — in the real machine room, much of the engineering is invisible from above.' },
    { title: 'Cryogenic chandelier', group: 'chandelier', at: [ 0.5, 0.55, 0.5 ], body: 'Inside the cryostat hangs the "chandelier": gold-plated stages, each roughly ten times colder than the one above, stepping down from room temperature to ~15 millikelvin at the quantum chip.' },
    { title: 'Service wings', group: 'wing', at: [ 0.15, 0.5, 0.5 ], body: 'The wings give technicians access to wiring and cryogenics — and the modular design means future System Twos can dock additional units.' },
    { title: 'Glass shell', group: 'glass', at: [ 0.9, 0.6, 0.5 ], body: 'Like System One before it, the machine shows itself off: the enclosure is transparent, turning the computer into an exhibit.' },
  ],
};

function createViewer( container, modelUrl ) {

  const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: true } );
  renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
  renderer.setSize( container.clientWidth, container.clientHeight );
  container.appendChild( renderer.domElement );

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera( 45, container.clientWidth / container.clientHeight, 1, 1e5 );
  camera.position.set( 200, 150, 250 );

  scene.add( new THREE.HemisphereLight( 0xffffff, 0x4a5a6a, 2.4 ) );
  const dir = new THREE.DirectionalLight( 0xffffff, 2.0 );
  dir.position.set( 1, 1.6, 1.2 );
  scene.add( dir );

  const controls = new OrbitControls( camera, renderer.domElement );
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 1.2;

  // Build animation style: 'fall' = bricks drop into place; 'reveal' = plain pop-in.
  const BUILD_STYLE = 'fall';

  // Honour the OS "reduce motion" setting: no auto-spin, no auto-play, no drop.
  const reduceMotion = window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

  const slug = ( modelUrl.match( /([^/]+)\.[a-z]+$/i ) || [] )[ 1 ] || modelUrl;

  let model = null;
  let modelMaxDim = 100;
  let brickGroups = null; // cached per-brick groups with rest/explode data
  let buildAnim = null; // active falling-bricks animation state, or null
  let hasAutoPlayed = false;
  let explodeFactor = 0; // current radial spread, 0 = assembled
  let explodeTarget = 0; // where it's easing toward
  let exploded = false;
  let explodeBtn = null;
  let scrubber = null; // range input that tracks / seeks build progress
  let playBtn = null; // play / pause toggle for the build animation
  let restartAt = null; // timestamp to auto-replay at (endless loop), or null
  let visible = false; // in-viewport flag; set by the IntersectionObserver

  let meta = null; // parsed MPD metadata (colours, part names, step captions)
  loadMeta( modelUrl ).then( m => { meta = m; } );

  // Step-through instruction mode
  let stepMode = false;
  let curStep = 0;
  let numSteps = 1;
  let stepNames = null; // per-step caption derived from submodel names, lazy
  let statusLabel = null; // shared label: brick counter while playing, step while stepping
  let stepFlash = null; // { bricks, until } — bricks highlighted for the current step

  // Part identification / highlight
  const highlightMats = new Map(); // original material -> emissive clone
  let flashRestore = null; // pending restore for a click-flash
  let chip = null; // part-info card
  let chipTimer = null;

  // Parts list panel
  let partsPanel = null;
  let partsSelected = null; // { key, restore } for the highlighted lot

  // Anatomy tour
  let tour = null; // { spots, dotsEl, card, open, idx }
  let camTween = null; // active camera fly-to, or null

  // Superposition easter egg
  let ghost = null; // { copy, matsA, matsB, lines, origByMesh, phase, collapsing }
  let psiHint = null;

  const LOOP_DELAY = 3000; // ms to hold the finished model before looping
  let running = false;

  const isMine = pendingShare && pendingShare.v === slug ? pendingShare : null;
  if ( isMine ) hasAutoPlayed = true; // a shared view takes precedence over autoplay

  const loader = new LDrawLoader();
  // smoothNormals looks nicer but is ~15x slower to parse (≈12 s vs <1 s on the
  // 1024-brick model). Heavy models opt out via data-smooth-normals="false" to
  // avoid a multi-second main-thread freeze on load.
  loader.smoothNormals = container.dataset.smoothNormals !== 'false';
  container.classList.add( 'is-loading' );

  loader.load( modelUrl, onLoad, undefined, onError );

  function onError( err ) {
    container.classList.remove( 'is-loading' );
    container.classList.add( 'has-error' );
    console.error( 'LDraw load failed for', modelUrl, err );
  }

  function onLoad( group ) {
    container.classList.remove( 'is-loading' );
    model = group;
    numSteps = Math.max( 1, model.userData.numBuildingSteps || 1 );

    // LDraw space is Y-down; flip so the model is upright.
    model.rotation.x = Math.PI;

    // Recenter on origin and frame the camera to fit.
    const box = new THREE.Box3().setFromObject( model );
    const size = box.getSize( new THREE.Vector3() );
    const center = box.getCenter( new THREE.Vector3() );
    model.position.sub( center );
    scene.add( model );

    const maxDim = Math.max( size.x, size.y, size.z );
    modelMaxDim = maxDim;
    const dist = ( maxDim / 2 ) / Math.tan( ( camera.fov / 2 ) * Math.PI / 180 ) * 1.6;
    camera.position.set( dist * 0.85, dist * 0.55, dist );
    camera.near = maxDim / 100;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.target.set( 0, 0, 0 );
    controls.update();

    addContactShadow( size );
    addControls();

    // Gentle auto-spin on the finished model (unless the user prefers no motion).
    controls.autoRotate = ! reduceMotion;

    if ( isMine ) applySharedView();
    maybeAutoPlay();
  }

  function applySharedView() {
    if ( isMine.cp ) camera.position.fromArray( isMine.cp );
    if ( isMine.ct ) controls.target.fromArray( isMine.ct );
    controls.update();
    controls.autoRotate = false;
    if ( isMine.s !== null ) enterStepMode( isMine.s );
    setTimeout( () => container.scrollIntoView( { block: 'center', behavior: 'smooth' } ), 100 );
  }

  // A soft blob shadow on the ground so the model doesn't look like it floats.
  // Cheap CanvasTexture sprite — no per-frame shadow-map cost (matters on the 1024).
  function addContactShadow( size ) {
    const c = document.createElement( 'canvas' );
    c.width = c.height = 256;
    const ctx = c.getContext( '2d' );
    const g = ctx.createRadialGradient( 128, 128, 0, 128, 128, 128 );
    g.addColorStop( 0, 'rgba(0,0,0,0.38)' );
    g.addColorStop( 0.5, 'rgba(0,0,0,0.16)' );
    g.addColorStop( 1, 'rgba(0,0,0,0)' );
    ctx.fillStyle = g;
    ctx.fillRect( 0, 0, 256, 256 );

    const tex = new THREE.CanvasTexture( c );
    const mat = new THREE.MeshBasicMaterial( { map: tex, transparent: true, depthWrite: false } );
    const side = Math.max( size.x, size.z ) * 1.9;
    const plane = new THREE.Mesh( new THREE.PlaneGeometry( side, side ), mat );
    plane.rotation.x = - Math.PI / 2;
    plane.position.y = - size.y / 2 - maxDimEpsilon();
    plane.renderOrder = - 1;
    scene.add( plane );
  }

  function maxDimEpsilon() { return modelMaxDim * 0.002; }

  // Each brick is the group that directly holds a mesh + its outline edges.
  // Collect those groups once, caching per brick: rest position, world-up
  // direction and radial offset from the model centre, all expressed in the
  // brick's parent-local frame so nested/rotated submodels behave correctly.
  function ensureBrickData() {
    if ( brickGroups ) return brickGroups;
    const seen = new Set();
    const arr = [];
    let order = 0;
    const worldUp = new THREE.Vector3( 0, 1, 0 );
    model.updateWorldMatrix( true, true );
    model.traverse( c => {
      if ( ! ( c.isMesh || c.isLineSegments || c.isLine ) ) return;
      const g = c.parent;
      if ( ! g || seen.has( g ) ) return;
      seen.add( g );
      const invParent = g.parent.getWorldQuaternion( new THREE.Quaternion() ).invert();
      g.userData.restPos = g.position.clone();
      g.userData.upLocal = worldUp.clone().applyQuaternion( invParent ).normalize();
      // Model is centred at the origin, so the brick's world position IS its
      // offset from centre; express that as a parent-local vector for explode.
      g.userData.offsetLocal = g.getWorldPosition( new THREE.Vector3() ).applyQuaternion( invParent );
      g.userData.step = buildingStepOf( g );
      g.userData.order = order ++;
      arr.push( g );
    } );
    brickGroups = arr;
    return arr;
  }

  function bricksInBuildOrder() {
    return ensureBrickData().slice().sort(
      ( a, b ) => ( a.userData.step - b.userData.step ) || ( a.userData.order - b.userData.order )
    );
  }

  // ------------------------------------------------------------ state guards

  // Puts the model back into the plain assembled state before another feature
  // takes over: no build animation, no explode, no step filter, no ghost.
  function normalizeState() {
    if ( ghost ) collapseGhost( null ); // instant teardown, no measurement
    if ( buildAnim ) finishBuild();
    if ( stepMode ) exitStepMode();
    if ( exploded || explodeFactor > 0.001 ) {
      exploded = false;
      explodeTarget = 0;
      if ( explodeBtn ) explodeBtn.textContent = '⤢ Explode';
    }
    restartAt = null;
  }

  // ------------------------------------------------------ build animation

  // Builds the animation timeline (brick order + timing) without starting the
  // clock. Lazily created so the scrubber can seek into a build even before the
  // user presses play. Returns null for models too small to animate.
  function ensureBuildTimeline() {
    if ( buildAnim ) return buildAnim;
    const bricks = bricksInBuildOrder();
    if ( bricks.length <= 1 ) return null;
    // ms between bricks; the floor stretches very large models (the 1024) so
    // its build runs ~50% longer instead of bottoming out too fast.
    const stagger = THREE.MathUtils.clamp( 4200 / bricks.length, 12, 110 );
    const fallDur = 800; // ms per brick to drop into place
    // Reduced-motion users get an instant in-order reveal with no drop.
    const dropHeight = ( BUILD_STYLE === 'fall' && ! reduceMotion ) ? modelMaxDim * 2.0 : 0;
    const totalDur = ( bricks.length - 1 ) * stagger + fallDur;
    buildAnim = { bricks, stagger, fallDur, dropHeight, totalDur, startTime: performance.now(), scrubbing: false, paused: false, progress: 0 };
    container.classList.add( 'is-building' );
    controls.autoRotate = false;
    return buildAnim;
  }

  // Plays the build animation once, then returns to the finished + auto-spin state.
  // Safe to call repeatedly (e.g. from the Start button); restarts from the top.
  function playBuild() {
    if ( ! model ) return;
    if ( ghost ) collapseGhost( null );
    if ( stepMode ) exitStepMode();
    finishBuild(); // reset any in-flight build / explode before restarting
    const a = ensureBuildTimeline();
    if ( ! a ) return;
    a.startTime = performance.now();
    a.scrubbing = false;
    a.paused = false;
    a.progress = 0;
    restartAt = null;
    updatePlayBtn();
  }

  // Play/pause toggle: starts a build if none is running, otherwise pauses or
  // resumes the current one.
  function togglePlay() {
    if ( ! model ) return;
    if ( ! buildAnim || stepMode ) { playBuild(); return; }
    if ( buildAnim.paused ) {
      buildAnim.paused = false;
      buildAnim.startTime = performance.now() - buildAnim.progress * buildAnim.totalDur;
    } else {
      buildAnim.paused = true;
    }
    updatePlayBtn();
  }

  function updatePlayBtn() {
    if ( ! playBtn ) return;
    const playing = buildAnim && ! buildAnim.paused && ! buildAnim.scrubbing;
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute( 'aria-label', playing ? 'Pause' : 'Play build animation' );
  }

  // Positions/reveals every brick for a given point on the timeline (ms).
  function applyBuildAt( elapsed ) {
    const { bricks, stagger, fallDur, dropHeight } = buildAnim;
    let landed = 0;
    for ( let i = 0; i < bricks.length; i ++ ) {
      const e = elapsed - i * stagger;
      const g = bricks[ i ];
      if ( e < 0 ) { g.visible = false; continue; }
      landed ++;
      g.visible = true;
      if ( dropHeight > 0 ) {
        const t = Math.min( 1, e / fallDur );
        const h = dropHeight * ( 1 - t * t ); // ease-in: accelerate like gravity
        g.position.copy( g.userData.restPos ).addScaledVector( g.userData.upLocal, h );
      }
    }
    setStatus( `🧱 ${landed} / ${bricks.length}` );
  }

  // Advances (or holds, while paused/scrubbing) the build animation; per frame.
  function stepBuildAnim() {
    if ( ! buildAnim ) return;
    const a = buildAnim;
    const held = a.scrubbing || a.paused;
    let elapsed;
    if ( held ) {
      elapsed = a.progress * a.totalDur;
    } else {
      elapsed = performance.now() - a.startTime;
      a.progress = Math.min( 1, elapsed / a.totalDur );
    }
    applyBuildAt( Math.min( elapsed, a.totalDur ) );
    if ( scrubber && ! a.scrubbing ) scrubber.value = Math.min( 1, elapsed / a.totalDur ) * 1000;
    if ( ! held && elapsed >= a.totalDur ) {
      finishBuild();
      if ( ! reduceMotion ) restartAt = performance.now() + LOOP_DELAY; // endless loop
    }
  }

  // User grabbed the scrubber: hold the build at the dragged position.
  function onScrubInput() {
    if ( stepMode ) exitStepMode();
    if ( ghost ) collapseGhost( null );
    const a = ensureBuildTimeline();
    if ( ! a ) return;
    a.scrubbing = true;
    a.progress = scrubber.value / 1000;
    restartAt = null; // user took control; stop the auto-loop
    updatePlayBtn();
  }

  // User released the scrubber: resume from here, preserving the paused state.
  function onScrubRelease() {
    const a = buildAnim;
    if ( ! a ) return;
    const p = scrubber.value / 1000;
    a.progress = p;
    a.scrubbing = false;
    if ( p >= 1 && ! a.paused ) { finishBuild(); return; }
    if ( ! a.paused ) a.startTime = performance.now() - p * a.totalDur;
    updatePlayBtn();
  }

  function finishBuild() {
    buildAnim = null;
    explodeTarget = explodeFactor = 0;
    exploded = false;
    if ( explodeBtn ) explodeBtn.textContent = '⤢ Explode';
    if ( scrubber ) scrubber.value = 0;
    updatePlayBtn();
    if ( ! stepMode ) setStatus( '' );
    if ( model ) model.traverse( c => {
      if ( c.isMesh || c.isLineSegments || c.isLine ) c.visible = true;
      else if ( c.isGroup ) {
        c.visible = true;
        if ( c.userData.restPos ) c.position.copy( c.userData.restPos );
      }
    } );
    container.classList.remove( 'is-building' );
    if ( stepMode ) applyStep(); // step filter survives a finishBuild reset
    controls.autoRotate = ! reduceMotion && ! stepMode;
  }

  // First time the viewer is both loaded and on screen, play the build once.
  function maybeAutoPlay() {
    if ( hasAutoPlayed || reduceMotion || ! model || ! visible ) return;
    hasAutoPlayed = true;
    playBuild();
  }

  // ------------------------------------------------------------- explode

  function toggleExplode() {
    if ( ! model ) return;
    restartAt = null; // exploring pauses the auto-loop
    if ( ghost ) collapseGhost( null );
    if ( stepMode ) exitStepMode();
    if ( buildAnim ) finishBuild(); // can't explode mid-build
    ensureBrickData();
    exploded = ! exploded;
    explodeTarget = exploded ? 1 : 0;
    controls.autoRotate = ! reduceMotion;
    if ( explodeBtn ) explodeBtn.textContent = exploded ? '⤡ Collapse' : '⤢ Explode';
  }

  // Eases the radial spread toward its target; called once per rendered frame.
  function stepExplode() {
    if ( ! model || ! brickGroups || buildAnim ) return;
    const settled = Math.abs( explodeFactor - explodeTarget ) < 0.001;
    if ( settled && explodeFactor === 0 ) return; // assembled and idle
    explodeFactor = settled ? explodeTarget : explodeFactor + ( explodeTarget - explodeFactor ) * 0.15;
    const k = 0.6 * explodeFactor;
    for ( const g of brickGroups ) g.position.copy( g.userData.restPos ).addScaledVector( g.userData.offsetLocal, k );
  }

  // ------------------------------------------------- step-through instructions

  function setStatus( text ) {
    if ( ! statusLabel ) return;
    statusLabel.textContent = text;
    statusLabel.style.display = text ? '' : 'none';
  }

  // Caption for a step: Studio's own step description when the file has them
  // (System One), otherwise the name of the submodel most of the step's bricks
  // belong to (Wall, Cryostat, Rack, ... in the other two models).
  function stepCaption( n ) {
    const fromFile = meta && meta.captions && meta.captions[ n ];
    if ( fromFile ) return fromFile;
    if ( ! stepNames ) {
      stepNames = [];
      const tally = [];
      for ( const g of ensureBrickData() ) {
        const s = g.userData.step;
        let name = '';
        for ( let a = g.parent; a && a !== model.parent; a = a.parent ) {
          if ( a === model ) break;
          if ( a.name && ! /\.dat$/i.test( a.name ) ) { name = a.name; break; }
        }
        if ( ! name ) continue;
        ( tally[ s ] = tally[ s ] || {} )[ name ] = ( ( tally[ s ] || {} )[ name ] || 0 ) + 1;
      }
      tally.forEach( ( t, s ) => {
        stepNames[ s ] = titleCase( Object.entries( t ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ][ 0 ] );
      } );
    }
    return stepNames[ n ] || '';
  }

  function enterStepMode( n ) {
    if ( ! model ) return;
    if ( ghost ) collapseGhost( null );
    if ( buildAnim ) finishBuild();
    exploded = false;
    explodeTarget = 0;
    if ( explodeBtn ) explodeBtn.textContent = '⤢ Explode';
    closeTour();
    ensureBrickData();
    stepMode = true;
    controls.autoRotate = false;
    setStep( THREE.MathUtils.clamp( n, 0, numSteps - 1 ) );
  }

  function exitStepMode() {
    if ( ! stepMode ) return;
    stepMode = false;
    stepFlash = null;
    setStatus( '' );
    if ( model ) for ( const g of ensureBrickData() ) g.visible = true;
    controls.autoRotate = ! reduceMotion;
  }

  function setStep( n ) {
    curStep = n;
    applyStep();
    const cap = stepCaption( n );
    setStatus( `Step ${n + 1} / ${numSteps}${cap ? ' · ' + cap : ''}` );
    if ( ! reduceMotion ) {
      const fresh = ensureBrickData().filter( g => g.userData.step === n );
      stepFlash = { bricks: fresh, until: performance.now() + 750, applied: false };
    }
  }

  function applyStep() {
    for ( const g of ensureBrickData() ) g.visible = g.userData.step <= curStep;
  }

  // Briefly tints the bricks added by the current step so they stand out.
  function stepStepFlash() {
    if ( ! stepFlash ) return;
    const now = performance.now();
    if ( ! stepFlash.applied ) {
      stepFlash.applied = true;
      stepFlash.restore = swapHighlight( stepFlash.bricks );
    }
    if ( now >= stepFlash.until ) {
      stepFlash.restore();
      stepFlash = null;
    }
  }

  function stepPrev() {
    if ( ! model ) return;
    if ( ! stepMode ) { enterStepMode( numSteps - 1 ); return; }
    if ( curStep <= 0 ) { exitStepMode(); return; }
    setStep( curStep - 1 );
  }

  function stepNext() {
    if ( ! model ) return;
    if ( ! stepMode ) { enterStepMode( 0 ); return; }
    if ( curStep >= numSteps - 1 ) { exitStepMode(); return; }
    setStep( curStep + 1 );
  }

  // ------------------------------------------------- part identification

  // Swaps the mesh materials of the given bricks for an emissive-tinted clone;
  // returns a function that restores the originals. Clones are cached per
  // source material, so repeated highlights are cheap.
  function swapHighlight( bricks ) {
    const swapped = [];
    const hl = m => {
      if ( ! m || ! m.isMaterial || ! ( 'emissive' in m ) ) return m;
      if ( ! highlightMats.has( m ) ) {
        const c = m.clone();
        c.emissive = new THREE.Color( 0x1a7fd4 );
        c.emissiveIntensity = 0.65;
        highlightMats.set( m, c );
      }
      return highlightMats.get( m );
    };
    for ( const g of bricks ) {
      for ( const c of g.children ) {
        if ( ! c.isMesh ) continue;
        const orig = c.material;
        c.material = Array.isArray( orig ) ? orig.map( hl ) : hl( orig );
        swapped.push( [ c, orig ] );
      }
    }
    return () => { for ( const [ c, orig ] of swapped ) c.material = orig; };
  }

  // The brick a rendered object belongs to: nearest ancestor named like an
  // LDraw part file ("parts/3001.dat"); falls back to the mesh's parent group.
  function brickOf( obj ) {
    for ( let n = obj; n && n !== model; n = n.parent ) {
      if ( n.isGroup && /\.dat$/i.test( n.name || '' ) ) return n;
    }
    return obj.parent;
  }

  function identifyAt( ev ) {
    if ( ! model ) return;
    const r = container.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ( ( ev.clientX - r.left ) / r.width ) * 2 - 1,
      - ( ( ev.clientY - r.top ) / r.height ) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera( ndc, camera );
    // A brick hidden by step mode has visible=false on its group, not its mesh,
    // so effective visibility means checking the whole ancestor chain.
    const shown = o => { for ( let n = o; n; n = n.parent ) if ( ! n.visible ) return false; return true; };
    const hit = ray.intersectObject( model, true ).find( i => i.object.isMesh && shown( i.object ) );
    if ( ! hit ) { hideChip(); return; }

    const brick = brickOf( hit.object );
    if ( ! brick ) return;

    // Flash the brick.
    if ( flashRestore ) flashRestore();
    const restore = swapHighlight( [ brick ] );
    flashRestore = restore;
    setTimeout( () => { if ( flashRestore === restore ) { restore(); flashRestore = null; } }, 1200 );

    // Identify it.
    const file = ( brick.name || '' ).split( '/' ).pop().toLowerCase();
    const num = file.replace( /\.dat$/, '' );
    const desc = ( meta && meta.parts[ file ] ) || 'LEGO part';
    let code = brick.userData.colorCode;
    let colName = ( meta && meta.colors[ code ] && meta.colors[ code ].name ) || '';
    let colHex = ( meta && meta.colors[ code ] && meta.colors[ code ].hex ) || '';
    if ( ! colHex ) {
      const m = Array.isArray( hit.object.material ) ? hit.object.material[ 0 ] : hit.object.material;
      if ( m && m.color ) colHex = '#' + m.color.getHexString();
      if ( m && ! colName ) colName = m.name || '';
    }
    showChip( { num, desc, colName, colHex } );
  }

  function showChip( { num, desc, colName, colHex } ) {
    if ( ! chip ) {
      chip = document.createElement( 'div' );
      chip.className = 'viewer-chip';
      container.appendChild( chip );
    }
    chip.innerHTML = '';
    const sw = document.createElement( 'span' );
    sw.className = 'viewer-chip-swatch';
    sw.style.background = colHex || '#ccc';
    const txt = document.createElement( 'span' );
    txt.textContent = `${desc} · ${num}${colName ? ' · ' + colName : ''}`;
    const link = document.createElement( 'a' );
    link.href = `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${encodeURIComponent( num )}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'BrickLink ↗';
    chip.append( sw, txt, link );
    chip.classList.add( 'is-open' );
    clearTimeout( chipTimer );
    chipTimer = setTimeout( hideChip, 5000 );
  }

  function hideChip() {
    if ( chip ) chip.classList.remove( 'is-open' );
    clearTimeout( chipTimer );
  }

  // ---------------------------------------------------------- parts panel

  function togglePartsPanel() {
    if ( partsPanel ) {
      clearPartsSelection();
      partsPanel.remove();
      partsPanel = null;
      return;
    }
    if ( ! model ) return;
    const bricks = ensureBrickData();

    // Group bricks into lots: same part file + same colour.
    const lots = new Map();
    for ( const g of bricks ) {
      const file = ( g.name || '' ).split( '/' ).pop().toLowerCase();
      if ( ! /\.dat$/.test( file ) ) continue;
      const code = g.userData.colorCode !== undefined ? String( g.userData.colorCode ) : '?';
      const key = file + '|' + code;
      if ( ! lots.has( key ) ) lots.set( key, { file, code, count: 0, bricks: [] } );
      const lot = lots.get( key );
      lot.count ++;
      lot.bricks.push( g );
    }
    const sorted = [ ...lots.values() ].sort( ( a, b ) => b.count - a.count );

    partsPanel = document.createElement( 'div' );
    partsPanel.className = 'viewer-parts';
    const head = document.createElement( 'div' );
    head.className = 'viewer-parts-head';
    head.textContent = `${bricks.length} bricks · ${sorted.length} lots`;
    const close = document.createElement( 'button' );
    close.type = 'button';
    close.className = 'viewer-parts-close';
    close.textContent = '✕';
    close.setAttribute( 'aria-label', 'Close parts list' );
    close.addEventListener( 'click', togglePartsPanel );
    head.appendChild( close );
    partsPanel.appendChild( head );

    const list = document.createElement( 'div' );
    list.className = 'viewer-parts-list';
    for ( const lot of sorted ) {
      const num = lot.file.replace( /\.dat$/, '' );
      const desc = ( meta && meta.parts[ lot.file ] ) || num;
      const col = ( meta && meta.colors[ lot.code ] ) || {};
      const row = document.createElement( 'button' );
      row.type = 'button';
      row.className = 'viewer-parts-row';
      row.title = `${desc} (${num})${col.name ? ' — ' + col.name : ''}. Click to highlight in the model.`;
      const sw = document.createElement( 'span' );
      sw.className = 'viewer-chip-swatch';
      sw.style.background = col.hex || '#ccc';
      const label = document.createElement( 'span' );
      label.className = 'viewer-parts-name';
      label.textContent = desc;
      const count = document.createElement( 'span' );
      count.className = 'viewer-parts-count';
      count.textContent = '×' + lot.count;
      row.append( sw, label, count );
      row.addEventListener( 'click', () => selectLot( lot, row ) );
      list.appendChild( row );
    }
    partsPanel.appendChild( list );
    container.appendChild( partsPanel );
  }

  function clearPartsSelection() {
    if ( ! partsSelected ) return;
    partsSelected.restore();
    partsSelected.row.classList.remove( 'is-active' );
    partsSelected = null;
  }

  function selectLot( lot, row ) {
    const wasActive = partsSelected && partsSelected.key === lot.file + '|' + lot.code;
    clearPartsSelection();
    if ( wasActive ) return;
    partsSelected = { key: lot.file + '|' + lot.code, restore: swapHighlight( lot.bricks ), row };
    row.classList.add( 'is-active' );
  }

  // -------------------------------------------------------------- anatomy tour

  function resolveAnchor( spec ) {
    const world = new THREE.Vector3();
    const box = new THREE.Box3();

    if ( spec.group ) {
      const matches = [];
      model.traverse( g => {
        if ( g.isGroup && g.name && ! /\.dat$/i.test( g.name ) &&
             g.name.toLowerCase().includes( spec.group ) ) matches.push( g );
      } );
      if ( matches.length ) {
        const all = new THREE.Box3();
        for ( const g of matches ) all.union( box.setFromObject( g ) );
        return model.worldToLocal( all.getCenter( world ) );
      }
    }
    if ( spec.stepDesc && meta && meta.captions.length ) {
      const steps = [];
      meta.captions.forEach( ( c, i ) => { if ( c && c.startsWith( spec.stepDesc ) ) steps.push( i ); } );
      const bricks = ensureBrickData().filter( g => steps.includes( g.userData.step ) );
      if ( bricks.length ) {
        const all = new THREE.Box3();
        for ( const g of bricks ) all.union( box.setFromObject( g ) );
        return model.worldToLocal( all.getCenter( world ) );
      }
    }
    // Fallback: normalised bounding-box coordinates on the assembled model.
    const mb = new THREE.Box3().setFromObject( model );
    const size = mb.getSize( new THREE.Vector3() );
    world.set(
      mb.min.x + spec.at[ 0 ] * size.x,
      mb.min.y + spec.at[ 1 ] * size.y,
      mb.min.z + spec.at[ 2 ] * size.z
    );
    return model.worldToLocal( world );
  }

  function toggleTour() {
    if ( tour && tour.open ) { closeTour(); return; }
    if ( ! model || ! ANATOMY[ slug ] ) return;
    normalizeState();
    if ( ! tour ) {
      const spots = ANATOMY[ slug ].map( spec => ( { ...spec, local: resolveAnchor( spec ) } ) );
      const dotsEl = document.createElement( 'div' );
      dotsEl.className = 'viewer-hotspots';
      spots.forEach( ( s, i ) => {
        const d = document.createElement( 'button' );
        d.type = 'button';
        d.className = 'viewer-hotspot';
        d.textContent = String( i + 1 );
        d.setAttribute( 'aria-label', s.title );
        d.addEventListener( 'click', () => openSpot( i ) );
        dotsEl.appendChild( d );
        s.dot = d;
      } );
      const card = document.createElement( 'div' );
      card.className = 'viewer-tourcard';
      container.append( dotsEl, card );
      tour = { spots, dotsEl, card, open: false, idx: - 1 };
    }
    tour.open = true;
    tour.dotsEl.style.display = '';
    controls.autoRotate = false;
    openSpot( 0 );
  }

  function closeTour() {
    if ( ! tour || ! tour.open ) return;
    tour.open = false;
    tour.idx = - 1;
    tour.dotsEl.style.display = 'none';
    tour.card.classList.remove( 'is-open' );
    camTween = null;
    controls.autoRotate = ! reduceMotion && ! stepMode;
  }

  function openSpot( i ) {
    const s = tour.spots[ i ];
    tour.idx = i;
    tour.spots.forEach( ( sp, j ) => sp.dot.classList.toggle( 'is-active', j === i ) );

    // Fly the camera: keep the current viewing direction, close in on the spot.
    const target = model.localToWorld( s.local.clone() );
    const dir = camera.position.clone().sub( controls.target ).normalize();
    const pos = target.clone().addScaledVector( dir, modelMaxDim * 2.0 );
    camTween = {
      p0: camera.position.clone(), p1: pos,
      t0: controls.target.clone(), t1: target,
      start: performance.now(), dur: reduceMotion ? 1 : 750,
    };

    const card = tour.card;
    card.innerHTML = '';
    const h = document.createElement( 'strong' );
    h.textContent = `${i + 1}. ${s.title}`;
    const p = document.createElement( 'p' );
    p.textContent = s.body;
    const nav = document.createElement( 'div' );
    nav.className = 'viewer-tourcard-nav';
    const prev = viewerButton( '‹', () => openSpot( ( i - 1 + tour.spots.length ) % tour.spots.length ) );
    const next = viewerButton( '›', () => openSpot( ( i + 1 ) % tour.spots.length ) );
    const done = viewerButton( '✕', closeTour );
    prev.setAttribute( 'aria-label', 'Previous stop' );
    next.setAttribute( 'aria-label', 'Next stop' );
    done.setAttribute( 'aria-label', 'End tour' );
    nav.append( prev, next, done );
    card.append( h, p, nav );
    card.classList.add( 'is-open' );
  }

  function stepCamTween() {
    if ( ! camTween ) return;
    const t = Math.min( 1, ( performance.now() - camTween.start ) / camTween.dur );
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow( - 2 * t + 2, 3 ) / 2; // easeInOutCubic
    camera.position.lerpVectors( camTween.p0, camTween.p1, e );
    controls.target.lerpVectors( camTween.t0, camTween.t1, e );
    if ( t >= 1 ) camTween = null;
  }

  function updateHotspotDots() {
    if ( ! tour || ! tour.open ) return;
    const w = container.clientWidth, h = container.clientHeight;
    const v = new THREE.Vector3();
    for ( const s of tour.spots ) {
      v.copy( s.local );
      model.localToWorld( v ).project( camera );
      const behind = v.z > 1;
      s.dot.style.display = behind ? 'none' : '';
      if ( ! behind ) {
        s.dot.style.left = ( ( v.x + 1 ) / 2 * w ) + 'px';
        s.dot.style.top = ( ( 1 - v.y ) / 2 * h ) + 'px';
      }
    }
  }

  // ------------------------------------------------------- superposition (ψ)

  function ghostMaterialSet() {
    // One transparent clone per unique source material, per copy, so the two
    // states can fade independently during the collapse.
    const make = () => {
      const map = new Map();
      return m => {
        if ( ! m || ! m.isMaterial ) return m;
        if ( ! map.has( m ) ) {
          const c = m.clone();
          c.transparent = true;
          c.opacity = 0.42;
          c.depthWrite = false;
          map.set( m, c );
        }
        return map.get( m );
      };
    };
    return { a: make(), b: make() };
  }

  function toggleSuperposition() {
    if ( ! model ) return;
    if ( ghost ) { measure(); return; }
    normalizeState();
    closeTour();
    hideChip();
    controls.autoRotate = false;

    const sets = ghostMaterialSet();
    const origByMesh = new Map();
    const matsA = [], matsB = [];
    const lines = [];

    model.traverse( c => {
      if ( c.isMesh ) {
        origByMesh.set( c, c.material );
        c.material = Array.isArray( c.material ) ? c.material.map( sets.a ) : sets.a( c.material );
        ( Array.isArray( c.material ) ? c.material : [ c.material ] ).forEach( m => matsA.includes( m ) || matsA.push( m ) );
      } else if ( c.isLineSegments || c.isLine ) {
        if ( c.visible ) { lines.push( c ); c.visible = false; } // edges kill the ghost look
      }
    } );

    const copy = model.clone( true );
    copy.traverse( c => {
      if ( c.isMesh ) {
        c.material = Array.isArray( c.material ) ? c.material.map( sets.b ) : sets.b( c.material );
        ( Array.isArray( c.material ) ? c.material : [ c.material ] ).forEach( m => matsB.includes( m ) || matsB.push( m ) );
      } else if ( c.isLineSegments || c.isLine ) {
        c.visible = false;
      }
    } );
    scene.add( copy );

    ghost = { copy, matsA, matsB, lines, origByMesh, start: performance.now(), collapsing: null };

    if ( ! psiHint ) {
      psiHint = document.createElement( 'div' );
      psiHint.className = 'viewer-psi-hint';
      psiHint.textContent = 'ψ  The model is in a superposition of two states — click it to measure.';
      container.appendChild( psiHint );
    }
    psiHint.classList.add( 'is-open' );
  }

  function measure() {
    if ( ! ghost || ghost.collapsing ) return;
    const outcome = Math.random() < 0.5 ? 0 : 1;
    ghost.collapsing = { outcome, start: performance.now(), dur: reduceMotion ? 1 : 550 };
    if ( psiHint ) psiHint.classList.remove( 'is-open' );
  }

  // Tears the superposition down. With an outcome (0 = original pose, 1 = the
  // rotated twin) it snaps the survivor's pose; with null it just cleans up.
  function collapseGhost( outcome ) {
    if ( ! ghost ) return;
    scene.remove( ghost.copy );
    for ( const [ mesh, mat ] of ghost.origByMesh ) mesh.material = mat;
    for ( const l of ghost.lines ) l.visible = true;
    model.rotation.y = 0;
    ghost = null;
    if ( psiHint ) psiHint.classList.remove( 'is-open' );
    if ( outcome !== null ) {
      toast( `Measured: |${outcome}⟩ — the superposition collapsed.` );
      controls.autoRotate = ! reduceMotion;
    }
  }

  function stepGhost() {
    if ( ! ghost ) return;
    const now = performance.now();

    if ( ghost.collapsing ) {
      const { outcome, start, dur } = ghost.collapsing;
      const t = Math.min( 1, ( now - start ) / dur );
      const keepMats = outcome === 0 ? ghost.matsA : ghost.matsB;
      const dropMats = outcome === 0 ? ghost.matsB : ghost.matsA;
      for ( const m of keepMats ) m.opacity = 0.42 + ( 1 - 0.42 ) * t;
      for ( const m of dropMats ) m.opacity = 0.42 * ( 1 - t );
      const keepObj = outcome === 0 ? model : ghost.copy;
      keepObj.rotation.y *= ( 1 - t );
      if ( t >= 1 ) collapseGhost( outcome );
      return;
    }

    // Idle superposition: the two states breathe apart around the rest pose.
    const t = ( now - ghost.start ) / 1000;
    const spread = 0.3 + 0.06 * Math.sin( t * 1.7 );
    model.rotation.y = - spread;
    ghost.copy.rotation.y = spread;
  }

  // ------------------------------------------------------ share & screenshot

  function toast( text ) {
    const el = document.createElement( 'div' );
    el.className = 'viewer-toast';
    el.textContent = text;
    container.appendChild( el );
    requestAnimationFrame( () => el.classList.add( 'is-open' ) );
    setTimeout( () => { el.classList.remove( 'is-open' ); setTimeout( () => el.remove(), 400 ); }, 2600 );
  }

  function screenshot() {
    if ( ! model ) return;
    renderer.render( scene, camera ); // fresh frame: the buffer isn't preserved
    const url = renderer.domElement.toDataURL( 'image/png' );
    const a = document.createElement( 'a' );
    a.href = url;
    a.download = `${slug}.png`;
    a.click();
  }

  function shareView() {
    const f = n => ( Math.round( n * 10 ) / 10 ).toString();
    const v3 = v => [ v.x, v.y, v.z ].map( f ).join( ',' );
    let hash = `#v=${slug}&cp=${v3( camera.position )}&ct=${v3( controls.target )}`;
    if ( stepMode ) hash += `&s=${curStep}`;
    const url = location.origin + location.pathname + hash;
    if ( navigator.clipboard && navigator.clipboard.writeText ) {
      navigator.clipboard.writeText( url ).then(
        () => toast( 'Link to this view copied to clipboard.' ),
        () => toast( url )
      );
    } else {
      toast( url );
    }
  }

  // --------------------------------------------------------------- controls

  function toggleFullscreen() {
    if ( document.fullscreenElement === container ) {
      document.exitFullscreen();
    } else if ( container.requestFullscreen ) {
      container.requestFullscreen();
    }
  }

  function addControls() {
    const bar = document.createElement( 'div' );
    bar.className = 'viewer-controls';
    explodeBtn = viewerButton( '⤢ Explode', toggleExplode );
    if ( ANATOMY[ slug ] ) bar.appendChild( viewerButton( 'ℹ️ Tour', toggleTour ) );
    bar.appendChild( viewerButton( '🧱 Parts', togglePartsPanel ) );
    bar.appendChild( explodeBtn );
    if ( container.dataset.ar ) bar.appendChild( viewerButton( '📱 View in AR', openAR ) );
    if ( container.requestFullscreen ) bar.appendChild( viewerButton( '⛶ Fullscreen', toggleFullscreen ) );

    // Small icon-only extras on their own row.
    const extras = document.createElement( 'div' );
    extras.className = 'viewer-extras';
    const psi = viewerButton( 'ψ', toggleSuperposition );
    psi.title = 'Superposition: view the model in two states at once, then click to measure';
    psi.setAttribute( 'aria-label', 'Superposition easter egg' );
    const shot = viewerButton( '📸', screenshot );
    shot.title = 'Save a screenshot of this view';
    shot.setAttribute( 'aria-label', 'Save screenshot' );
    const share = viewerButton( '🔗', shareView );
    share.title = 'Copy a link to this exact view';
    share.setAttribute( 'aria-label', 'Copy link to this view' );
    extras.append( psi, shot, share );

    container.append( bar, extras );

    // Transport bar: play/pause, drag-to-seek, status label, step buttons.
    const transport = document.createElement( 'div' );
    transport.className = 'viewer-transport';
    playBtn = viewerButton( '▶', togglePlay );
    playBtn.classList.add( 'viewer-play' );
    playBtn.setAttribute( 'aria-label', 'Play build animation' );
    scrubber = document.createElement( 'input' );
    scrubber.type = 'range';
    scrubber.min = 0;
    scrubber.max = 1000;
    scrubber.value = 0;
    scrubber.className = 'viewer-scrub';
    scrubber.setAttribute( 'aria-label', 'Build animation progress' );
    scrubber.addEventListener( 'input', onScrubInput );
    scrubber.addEventListener( 'change', onScrubRelease );

    statusLabel = document.createElement( 'span' );
    statusLabel.className = 'viewer-status';
    statusLabel.style.display = 'none';

    const sPrev = viewerButton( '‹', stepPrev );
    sPrev.classList.add( 'viewer-play' );
    sPrev.title = 'Previous building step';
    sPrev.setAttribute( 'aria-label', 'Previous building step' );
    const sNext = viewerButton( '›', stepNext );
    sNext.classList.add( 'viewer-play' );
    sNext.title = 'Next building step';
    sNext.setAttribute( 'aria-label', 'Next building step' );

    transport.append( playBtn, scrubber, statusLabel, sPrev, sNext );
    container.appendChild( transport );

    // Click-to-identify (and click-to-measure while in superposition). A click
    // is a pointerup that barely moved, so orbiting never triggers it.
    let downAt = null;
    renderer.domElement.addEventListener( 'pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; } );
    renderer.domElement.addEventListener( 'pointerup', e => {
      if ( ! downAt ) return;
      const moved = Math.hypot( e.clientX - downAt.x, e.clientY - downAt.y );
      downAt = null;
      if ( moved > 7 ) return;
      if ( ghost ) { measure(); return; }
      identifyAt( e );
    } );

    // The quantum simulator lower on the page "runs" its circuits here: every
    // run sends a pulse that ripples through the bricks.
    window.addEventListener( 'quantego:pulse', () => {
      container.classList.remove( 'is-pulsing' );
      void container.offsetWidth; // restart the CSS animation
      container.classList.add( 'is-pulsing' );
      if ( model && ! buildAnim && ! ghost && ! stepMode && ! reduceMotion ) {
        ensureBrickData();
        explodeTarget = Math.max( explodeTarget, 0.18 );
        setTimeout( () => { explodeTarget = exploded ? 1 : 0; }, 420 );
      }
    } );
  }

  // Opens a lightweight overlay with <model-viewer>; on a phone its AR button
  // places the model in the room (GLB for Android/WebXR, USDZ for iOS Quick
  // Look). The model file is only fetched now, on demand.
  function openAR() {
    const overlay = document.createElement( 'div' );
    overlay.className = 'ar-overlay';

    const mv = document.createElement( 'model-viewer' );
    mv.className = 'ar-viewer';
    mv.setAttribute( 'src', container.dataset.ar );
    if ( container.dataset.arIos ) mv.setAttribute( 'ios-src', container.dataset.arIos );
    mv.setAttribute( 'ar', '' );
    mv.setAttribute( 'ar-modes', 'webxr scene-viewer quick-look' );
    mv.setAttribute( 'camera-controls', '' );
    mv.setAttribute( 'auto-rotate', '' );
    mv.setAttribute( 'shadow-intensity', '1' );

    const hint = document.createElement( 'p' );
    hint.className = 'ar-hint';
    hint.textContent = 'Drag to rotate. On a phone or tablet, tap the AR icon to place this model in your room.';

    const close = viewerButton( '✕ Close', () => overlay.remove() );
    close.classList.add( 'ar-close' );

    overlay.append( close, mv, hint );
    overlay.addEventListener( 'click', e => { if ( e.target === overlay ) overlay.remove(); } );
    document.body.appendChild( overlay );
    ensureModelViewer();
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
    if ( restartAt !== null && ! buildAnim && visible && performance.now() >= restartAt ) {
      restartAt = null;
      playBuild();
    }
    stepBuildAnim();
    stepExplode();
    stepStepFlash();
    stepGhost();
    stepCamTween();
    controls.update();
    renderer.render( scene, camera );
    updateHotspotDots();
  }

  function start() {
    if ( running ) return;
    running = true;
    renderLoop();
  }

  function stop() {
    running = false;
  }

  // Pause rendering and the build timer when the viewer scrolls offscreen.
  const visObserver = new IntersectionObserver( entries => {
    visible = entries[ 0 ].isIntersecting;
    if ( visible ) { start(); maybeAutoPlay(); } else stop();
  }, { threshold: 0.05 } );
  visObserver.observe( container );

  const ro = new ResizeObserver( () => {
    const w = container.clientWidth, h = container.clientHeight;
    if ( w === 0 || h === 0 ) return;
    renderer.setSize( w, h );
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  } );
  ro.observe( container );
}

// Loads several models into one scene at their true relative scale (LDraw units
// are shared across models) and lines them up so you can compare their sizes.
function createCompareViewer( container, urls ) {
  const reduceMotion = window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

  const renderer = new THREE.WebGLRenderer( { antialias: true, alpha: true } );
  renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
  renderer.setSize( container.clientWidth, container.clientHeight );
  container.appendChild( renderer.domElement );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera( 45, container.clientWidth / container.clientHeight, 1, 1e6 );
  camera.position.set( 200, 150, 250 );

  scene.add( new THREE.HemisphereLight( 0xffffff, 0x4a5a6a, 2.4 ) );
  const dir = new THREE.DirectionalLight( 0xffffff, 2.0 );
  dir.position.set( 1, 1.6, 1.2 );
  scene.add( dir );

  const controls = new OrbitControls( camera, renderer.domElement );
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = ! reduceMotion;
  controls.autoRotateSpeed = 0.8;

  const holder = new THREE.Group();
  scene.add( holder );
  const loaded = new Array( urls.length ).fill( null );
  let running = false;
  let bricks = null; // flat build sequence: model 0's bricks, then model 1's, …
  let buildAnim = null;
  let buildDrop = 100; // how high bricks fall from, set once laid out
  let scrubber = null;
  let playBtn = null;
  let restartAt = null; // timestamp to auto-replay at (endless loop), or null
  let hasAutoPlayed = false;

  const LOOP_DELAY = 3000; // ms to hold the finished row before looping
  const MODEL_GAP = 600; // ms pause after a model finishes before the next starts

  container.classList.add( 'is-loading' );
  urls.forEach( ( url, i ) => {
    const loader = new LDrawLoader();
    loader.smoothNormals = false; // keep the combined (incl. 1024) scene snappy
    loader.load( url, g => { loaded[ i ] = g; if ( loaded.every( Boolean ) ) layout(); },
      undefined, err => console.error( 'LDraw compare load failed for', url, err ) );
  } );

  // The circuit simulator's pulse lights this viewer up too (glow only — the
  // compare scene has no per-brick explode data).
  window.addEventListener( 'quantego:pulse', () => {
    container.classList.remove( 'is-pulsing' );
    void container.offsetWidth;
    container.classList.add( 'is-pulsing' );
  } );

  function layout() {
    container.classList.remove( 'is-loading' );
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let cursor = 0, gap = 0;

    loaded.forEach( g => {
      g.rotation.x = Math.PI; // LDraw is Y-down
      g.updateMatrixWorld( true );
      box.setFromObject( g );
      const size = box.getSize( new THREE.Vector3() );
      gap = Math.max( gap, size.x * 0.18 );
      // Sit on the ground (min.y -> 0), butt the left edge against the cursor,
      // and line up the front edges (max.z, the face nearest the camera) at z=0.
      g.position.y += - box.min.y;
      g.position.x += cursor - box.min.x;
      g.position.z += - box.max.z;
      holder.add( g );
      cursor += size.x + gap;
    } );

    // Centre the whole row on the origin.
    const total = cursor - gap;
    holder.position.x = - total / 2;

    holder.updateMatrixWorld( true );
    const all = new THREE.Box3().setFromObject( holder );
    const c = all.getCenter( new THREE.Vector3() );
    const s = all.getSize( v );
    const maxDim = Math.max( s.x, s.y, s.z );
    const dist = ( s.x / 2 ) / Math.tan( ( camera.fov / 2 ) * Math.PI / 180 ) * 1.15;
    camera.position.set( c.x + dist * 0.25, c.y + s.y * 0.4, c.z + dist );
    camera.near = maxDim / 200;
    camera.far = maxDim * 200;
    camera.updateProjectionMatrix();
    controls.target.copy( c );
    controls.update();

    buildDrop = s.y * 3.5; // bricks fall in from above the frame (offscreen)
    addCompareControls();
    maybeAutoPlay();
  }

  // Each brick is the group directly holding a mesh + outline edges. Gather them
  // across all models into one sequence — model 0 first, then 1, then 2 — each in
  // its own build-step order, so the row assembles one model after another.
  function collectBricks() {
    if ( bricks ) return bricks;
    const worldUp = new THREE.Vector3( 0, 1, 0 );
    const seq = [];
    holder.updateWorldMatrix( true, true );
    loaded.forEach( ( g, mi ) => {
      const seen = new Set();
      const arr = [];
      g.traverse( c => {
        if ( ! ( c.isMesh || c.isLineSegments || c.isLine ) ) return;
        const grp = c.parent;
        if ( ! grp || seen.has( grp ) ) return;
        seen.add( grp );
        const invParent = grp.parent.getWorldQuaternion( new THREE.Quaternion() ).invert();
        grp.userData.restPos = grp.position.clone();
        grp.userData.upLocal = worldUp.clone().applyQuaternion( invParent ).normalize();
        grp.userData.step = buildingStepOf( grp );
        grp.userData.modelIndex = mi;
        arr.push( grp );
      } );
      arr.sort( ( a, b ) => a.userData.step - b.userData.step ); // stable within a model
      arr.forEach( grp => seq.push( grp ) );
    } );
    bricks = seq;
    return seq;
  }

  function ensureCompareTimeline() {
    if ( buildAnim ) return buildAnim;
    const seq = collectBricks();
    if ( seq.length <= 1 ) return null;
    const stagger = THREE.MathUtils.clamp( 8000 / seq.length, 6, 60 );
    const fallDur = 1000; // a touch longer so the higher drop stays graceful
    const dropHeight = reduceMotion ? 0 : buildDrop;

    // Per-brick start time. Bricks within a model cascade `stagger` apart, but a
    // new model only begins once the previous one has fully landed (+ a gap), so
    // the models assemble strictly one after another.
    let t = 0, prev = null;
    for ( const g of seq ) {
      if ( prev && g.userData.modelIndex !== prev.userData.modelIndex ) {
        t = prev.userData.t0 + fallDur + MODEL_GAP;
      }
      g.userData.t0 = t;
      prev = g;
      t += stagger;
    }
    const totalDur = seq[ seq.length - 1 ].userData.t0 + fallDur;

    buildAnim = { bricks: seq, stagger, fallDur, dropHeight, totalDur, startTime: performance.now(), scrubbing: false, paused: false, progress: 0 };
    controls.autoRotate = false;
    return buildAnim;
  }

  function playBuild() {
    finishBuild();
    const a = ensureCompareTimeline();
    if ( ! a ) return;
    a.startTime = performance.now();
    a.scrubbing = false;
    a.paused = false;
    a.progress = 0;
    restartAt = null;
    updatePlayBtn();
  }

  function applyBuildAt( elapsed ) {
    const { bricks: seq, fallDur, dropHeight } = buildAnim;
    for ( let i = 0; i < seq.length; i ++ ) {
      const g = seq[ i ];
      const e = elapsed - g.userData.t0;
      if ( e < 0 ) { g.visible = false; continue; }
      g.visible = true;
      if ( dropHeight > 0 ) {
        const t = Math.min( 1, e / fallDur );
        const h = dropHeight * ( 1 - t * t );
        g.position.copy( g.userData.restPos ).addScaledVector( g.userData.upLocal, h );
      }
    }
  }

  function stepBuild() {
    if ( ! buildAnim ) return;
    const a = buildAnim;
    const held = a.scrubbing || a.paused;
    let elapsed;
    if ( held ) {
      elapsed = a.progress * a.totalDur;
    } else {
      elapsed = performance.now() - a.startTime;
      a.progress = Math.min( 1, elapsed / a.totalDur );
    }
    applyBuildAt( Math.min( elapsed, a.totalDur ) );
    if ( scrubber && ! a.scrubbing ) scrubber.value = Math.min( 1, elapsed / a.totalDur ) * 1000;
    if ( ! held && elapsed >= a.totalDur ) {
      finishBuild();
      if ( ! reduceMotion ) restartAt = performance.now() + LOOP_DELAY; // endless loop
    }
  }

  function maybeAutoPlay() {
    if ( hasAutoPlayed || reduceMotion || ! running || ! loaded.every( Boolean ) ) return;
    hasAutoPlayed = true;
    playBuild();
  }

  function finishBuild() {
    buildAnim = null;
    if ( scrubber ) scrubber.value = 0;
    loaded.forEach( g => g.traverse( c => {
      if ( c.isMesh || c.isLineSegments || c.isLine ) c.visible = true;
      else if ( c.isGroup ) {
        c.visible = true;
        if ( c.userData.restPos ) c.position.copy( c.userData.restPos );
      }
    } ) );
    controls.autoRotate = ! reduceMotion;
    updatePlayBtn();
  }

  function togglePlay() {
    if ( ! loaded.every( Boolean ) ) return;
    if ( ! buildAnim ) { playBuild(); return; }
    if ( buildAnim.paused ) {
      buildAnim.paused = false;
      buildAnim.startTime = performance.now() - buildAnim.progress * buildAnim.totalDur;
    } else {
      buildAnim.paused = true;
    }
    updatePlayBtn();
  }

  function updatePlayBtn() {
    if ( ! playBtn ) return;
    const playing = buildAnim && ! buildAnim.paused && ! buildAnim.scrubbing;
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute( 'aria-label', playing ? 'Pause' : 'Play build animation' );
  }

  function onScrubInput() {
    const a = ensureCompareTimeline();
    if ( ! a ) return;
    a.scrubbing = true;
    a.progress = scrubber.value / 1000;
    restartAt = null; // user took control; stop the auto-loop
    updatePlayBtn();
  }

  function onScrubRelease() {
    const a = buildAnim;
    if ( ! a ) return;
    const p = scrubber.value / 1000;
    a.progress = p;
    a.scrubbing = false;
    if ( p >= 1 && ! a.paused ) { finishBuild(); return; }
    if ( ! a.paused ) a.startTime = performance.now() - p * a.totalDur;
    updatePlayBtn();
  }

  function toggleFullscreen() {
    if ( document.fullscreenElement === container ) document.exitFullscreen();
    else if ( container.requestFullscreen ) container.requestFullscreen();
  }

  function addCompareControls() {
    if ( playBtn ) return; // already added

    if ( container.requestFullscreen ) {
      const bar = document.createElement( 'div' );
      bar.className = 'viewer-controls';
      bar.appendChild( viewerButton( '⛶ Fullscreen', toggleFullscreen ) );
      container.appendChild( bar );
    }

    const transport = document.createElement( 'div' );
    transport.className = 'viewer-transport';
    playBtn = viewerButton( '▶', togglePlay );
    playBtn.classList.add( 'viewer-play' );
    playBtn.setAttribute( 'aria-label', 'Play build animation' );
    scrubber = document.createElement( 'input' );
    scrubber.type = 'range';
    scrubber.min = 0;
    scrubber.max = 1000;
    scrubber.value = 0;
    scrubber.className = 'viewer-scrub';
    scrubber.setAttribute( 'aria-label', 'Build animation progress' );
    scrubber.addEventListener( 'input', onScrubInput );
    scrubber.addEventListener( 'change', onScrubRelease );
    transport.append( playBtn, scrubber );
    container.appendChild( transport );
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
    if ( restartAt !== null && ! buildAnim && performance.now() >= restartAt ) {
      restartAt = null;
      playBuild();
    }
    stepBuild();
    controls.update();
    renderer.render( scene, camera );
  }

  new IntersectionObserver( entries => {
    running = entries[ 0 ].isIntersecting;
    if ( running ) { renderLoop(); maybeAutoPlay(); }
  }, { threshold: 0.02 } ).observe( container );

  new ResizeObserver( () => {
    const w = container.clientWidth, h = container.clientHeight;
    if ( w === 0 || h === 0 ) return;
    renderer.setSize( w, h );
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  } ).observe( container );
}

function initAll() {
  const lazy = new IntersectionObserver( ( entries, observer ) => {
    for ( const entry of entries ) {
      if ( ! entry.isIntersecting ) continue;
      const el = entry.target;
      observer.unobserve( el );
      if ( el.dataset.models ) {
        createCompareViewer( el, el.dataset.models.split( ',' ).map( s => s.trim() ).filter( Boolean ) );
      } else {
        createViewer( el, el.dataset.model );
      }
    }
  }, { rootMargin: '200px' } );

  document.querySelectorAll( '.viewer[data-model], .viewer-compare[data-models]' ).forEach( el => lazy.observe( el ) );

  // A shared deep link must instantiate its viewer even before it's scrolled to.
  if ( pendingShare ) {
    const el = [ ...document.querySelectorAll( '.viewer[data-model]' ) ]
      .find( el => ( el.dataset.model || '' ).includes( pendingShare.v ) );
    if ( el ) { lazy.unobserve( el ); createViewer( el, el.dataset.model ); }
  }

  // The quantum circuit simulator is its own module, fetched only when the
  // page actually contains one.
  if ( document.querySelector( '.qsim' ) ) import( './qsim.js' ).then( m => m.initAll() );
}

if ( document.readyState === 'loading' ) {
  document.addEventListener( 'DOMContentLoaded', initAll );
} else {
  initAll();
}
