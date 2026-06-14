import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';

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

  let model = null;
  let modelMaxDim = 100;
  let buildAnim = null; // active falling-bricks animation state, or null
  let visible = true; // in-viewport flag
  let running = false;

  const loader = new LDrawLoader();
  loader.smoothNormals = true;
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

    // Show the finished model with a gentle auto-spin; the build is on demand.
    controls.autoRotate = true;
    addRebuildButton();
  }

  // Building step of an object = step of its nearest ancestor group that has one.
  function buildingStepOf( obj ) {
    for ( let n = obj; n; n = n.parent ) {
      if ( n.userData && n.userData.buildingStep !== undefined ) return n.userData.buildingStep;
    }
    return 0;
  }

  // Each brick is the group that directly holds a mesh + its outline edges.
  // Collect those groups once, in build order (by step, then natural order),
  // caching each brick's resting position and world-up direction (expressed in
  // its parent's local frame, so nested/rotated submodels still fall downward).
  function bricksInBuildOrder() {
    const seen = new Set();
    const bricks = [];
    let order = 0;
    const worldUp = new THREE.Vector3( 0, 1, 0 );
    model.updateWorldMatrix( true, true );
    model.traverse( c => {
      if ( ! ( c.isMesh || c.isLineSegments || c.isLine ) ) return;
      const g = c.parent;
      if ( ! g || seen.has( g ) ) return;
      seen.add( g );
      if ( ! g.userData.restPos ) {
        g.userData.restPos = g.position.clone();
        const invParent = g.parent.getWorldQuaternion( new THREE.Quaternion() ).invert();
        g.userData.upLocal = worldUp.clone().applyQuaternion( invParent ).normalize();
      }
      bricks.push( { group: g, step: buildingStepOf( g ), order: order ++ } );
    } );
    bricks.sort( ( a, b ) => ( a.step - b.step ) || ( a.order - b.order ) );
    return bricks.map( b => b.group );
  }

  // Plays the build animation once, then returns to the finished + auto-spin state.
  // Safe to call repeatedly (e.g. from the Replay button); restarts if already running.
  function playBuild() {
    if ( ! model ) return;
    finishBuild(); // reset any in-flight build before restarting
    const bricks = bricksInBuildOrder();
    if ( bricks.length <= 1 ) return;

    container.classList.add( 'is-building' );
    controls.autoRotate = false;
    bricks.forEach( g => ( g.visible = false ) );

    // ms between bricks; the floor stretches very large models (the 1024) so
    // its build runs ~50% longer instead of bottoming out too fast.
    const stagger = THREE.MathUtils.clamp( 4200 / bricks.length, 12, 110 );
    const fallDur = 800; // ms per brick to drop into place
    const dropHeight = BUILD_STYLE === 'fall' ? modelMaxDim * 2.0 : 0; // start above the visible frame
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
    if ( model ) model.traverse( c => {
      if ( c.isMesh || c.isLineSegments || c.isLine ) c.visible = true;
      else if ( c.isGroup ) {
        c.visible = true;
        if ( c.userData.restPos ) c.position.copy( c.userData.restPos );
      }
    } );
    container.classList.remove( 'is-building' );
    controls.autoRotate = true;
  }

  function addRebuildButton() {
    const btn = document.createElement( 'button' );
    btn.type = 'button';
    btn.className = 'rebuild-btn';
    btn.textContent = '▶ Start animation';
    btn.addEventListener( 'click', playBuild );
    container.appendChild( btn );
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
    stepBuildAnim();
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
    if ( visible ) start(); else stop();
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

function initAll() {
  const viewers = document.querySelectorAll( '.viewer[data-model]' );
  const obs = new IntersectionObserver( ( entries, observer ) => {
    for ( const entry of entries ) {
      if ( entry.isIntersecting ) {
        const el = entry.target;
        observer.unobserve( el );
        createViewer( el, el.dataset.model );
      }
    }
  }, { rootMargin: '200px' } );
  viewers.forEach( el => obs.observe( el ) );
}

if ( document.readyState === 'loading' ) {
  document.addEventListener( 'DOMContentLoaded', initAll );
} else {
  initAll();
}
