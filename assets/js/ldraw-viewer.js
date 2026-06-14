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

  let model = null;
  let modelMaxDim = 100;
  let brickGroups = null; // cached per-brick groups with rest/explode data
  let buildAnim = null; // active falling-bricks animation state, or null
  let hasAutoPlayed = false;
  let explodeFactor = 0; // current radial spread, 0 = assembled
  let explodeTarget = 0; // where it's easing toward
  let exploded = false;
  let explodeBtn = null;
  let visible = false; // in-viewport flag; set by the IntersectionObserver
  let running = false;

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
    maybeAutoPlay();
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

  // Building step of an object = step of its nearest ancestor group that has one.
  function buildingStepOf( obj ) {
    for ( let n = obj; n; n = n.parent ) {
      if ( n.userData && n.userData.buildingStep !== undefined ) return n.userData.buildingStep;
    }
    return 0;
  }

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

  // Plays the build animation once, then returns to the finished + auto-spin state.
  // Safe to call repeatedly (e.g. from the Replay button); restarts if already running.
  function playBuild() {
    if ( ! model ) return;
    finishBuild(); // reset any in-flight build / explode before restarting
    const bricks = bricksInBuildOrder();
    if ( bricks.length <= 1 ) return;

    container.classList.add( 'is-building' );
    controls.autoRotate = false;
    bricks.forEach( g => ( g.visible = false ) );

    // ms between bricks; the floor stretches very large models (the 1024) so
    // its build runs ~50% longer instead of bottoming out too fast.
    const stagger = THREE.MathUtils.clamp( 4200 / bricks.length, 12, 110 );
    const fallDur = 800; // ms per brick to drop into place
    // Reduced-motion users get an instant in-order reveal with no drop.
    const dropHeight = ( BUILD_STYLE === 'fall' && ! reduceMotion ) ? modelMaxDim * 2.0 : 0;
    buildAnim = { bricks, startTime: performance.now(), stagger, fallDur, dropHeight };
  }

  // Advances the falling-bricks animation; called once per rendered frame.
  function stepBuildAnim() {
    if ( ! buildAnim ) return;
    const { bricks, startTime, stagger, fallDur, dropHeight } = buildAnim;
    const elapsed = performance.now() - startTime;
    let allDone = true;
    for ( let i = 0; i < bricks.length; i ++ ) {
      const e = elapsed - i * stagger;
      const g = bricks[ i ];
      if ( e < 0 ) { g.visible = false; allDone = false; continue; }
      g.visible = true;
      if ( dropHeight > 0 ) {
        const t = Math.min( 1, e / fallDur );
        if ( t < 1 ) allDone = false;
        const h = dropHeight * ( 1 - t * t ); // ease-in: accelerate like gravity
        g.position.copy( g.userData.restPos ).addScaledVector( g.userData.upLocal, h );
      }
    }
    if ( allDone ) finishBuild();
  }

  function finishBuild() {
    buildAnim = null;
    explodeTarget = explodeFactor = 0;
    exploded = false;
    if ( explodeBtn ) explodeBtn.textContent = '⤢ Explode';
    if ( model ) model.traverse( c => {
      if ( c.isMesh || c.isLineSegments || c.isLine ) c.visible = true;
      else if ( c.isGroup ) {
        c.visible = true;
        if ( c.userData.restPos ) c.position.copy( c.userData.restPos );
      }
    } );
    container.classList.remove( 'is-building' );
    controls.autoRotate = ! reduceMotion;
  }

  // First time the viewer is both loaded and on screen, play the build once.
  function maybeAutoPlay() {
    if ( hasAutoPlayed || reduceMotion || ! model || ! visible ) return;
    hasAutoPlayed = true;
    playBuild();
  }

  function toggleExplode() {
    if ( ! model ) return;
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

  function toggleFullscreen() {
    if ( document.fullscreenElement === container ) {
      document.exitFullscreen();
    } else if ( container.requestFullscreen ) {
      container.requestFullscreen();
    }
  }

  function makeBtn( label, onClick ) {
    const btn = document.createElement( 'button' );
    btn.type = 'button';
    btn.className = 'viewer-btn';
    btn.textContent = label;
    btn.addEventListener( 'click', onClick );
    return btn;
  }

  function addControls() {
    const bar = document.createElement( 'div' );
    bar.className = 'viewer-controls';
    bar.appendChild( makeBtn( '▶ Start animation', playBuild ) );
    explodeBtn = makeBtn( '⤢ Explode', toggleExplode );
    bar.appendChild( explodeBtn );
    if ( container.dataset.ar ) bar.appendChild( makeBtn( '📱 View in AR', openAR ) );
    if ( container.requestFullscreen ) bar.appendChild( makeBtn( '⛶ Fullscreen', toggleFullscreen ) );
    container.appendChild( bar );
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

    const close = makeBtn( '✕ Close', () => overlay.remove() );
    close.classList.add( 'ar-close' );

    overlay.append( close, mv, hint );
    overlay.addEventListener( 'click', e => { if ( e.target === overlay ) overlay.remove(); } );
    document.body.appendChild( overlay );
    ensureModelViewer();
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
    stepBuildAnim();
    stepExplode();
    controls.update();
    renderer.render( scene, camera );
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

  container.classList.add( 'is-loading' );
  urls.forEach( ( url, i ) => {
    const loader = new LDrawLoader();
    loader.smoothNormals = false; // keep the combined (incl. 1024) scene snappy
    loader.load( url, g => { loaded[ i ] = g; if ( loaded.every( Boolean ) ) layout(); },
      undefined, err => console.error( 'LDraw compare load failed for', url, err ) );
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
      // Sit on the ground (min.y -> 0) and butt the left edge against the cursor.
      g.position.y += - box.min.y;
      g.position.x += cursor - box.min.x;
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
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
    controls.update();
    renderer.render( scene, camera );
  }

  new IntersectionObserver( entries => {
    running = entries[ 0 ].isIntersecting;
    if ( running ) renderLoop();
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
}

if ( document.readyState === 'loading' ) {
  document.addEventListener( 'DOMContentLoaded', initAll );
} else {
  initAll();
}
