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

  let model = null;
  let stepTimer = null;
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

  function showUpToStep( step ) {
    model.traverse( c => {
      if ( c.isGroup && c.userData.buildingStep !== undefined ) {
        c.visible = c.userData.buildingStep <= step;
      }
    } );
  }

  // Plays the build animation once, then returns to the finished + auto-spin state.
  // Safe to call repeatedly (e.g. from the Replay button); restarts if already running.
  function playBuild() {
    if ( ! model ) return;
    if ( stepTimer ) { clearInterval( stepTimer ); stepTimer = null; }
    container.classList.add( 'is-building' );
    controls.autoRotate = false;

    const numSteps = model.userData.numBuildingSteps || 1;

    if ( numSteps > 1 ) {
      let step = 0;
      showUpToStep( step );
      const interval = THREE.MathUtils.clamp( 6000 / numSteps, 35, 600 );
      stepTimer = setInterval( () => {
        step ++;
        showUpToStep( step );
        if ( step >= numSteps - 1 ) finishBuild();
      }, interval );
      return;
    }

    // No real steps: synthesize a build by revealing individual meshes.
    const parts = [];
    model.traverse( c => { if ( c.isMesh ) parts.push( c ); } );
    if ( parts.length <= 1 ) { finishBuild(); return; }
    parts.forEach( p => ( p.visible = false ) );
    let i = 0;
    const interval = THREE.MathUtils.clamp( 6000 / parts.length, 35, 600 );
    stepTimer = setInterval( () => {
      parts[ i ].visible = true;
      if ( ++i >= parts.length ) finishBuild();
    }, interval );
  }

  function finishBuild() {
    if ( stepTimer ) { clearInterval( stepTimer ); stepTimer = null; }
    if ( model ) showUpToStep( Infinity );
    container.classList.remove( 'is-building' );
    controls.autoRotate = true;
  }

  function addRebuildButton() {
    const btn = document.createElement( 'button' );
    btn.type = 'button';
    btn.className = 'rebuild-btn';
    btn.textContent = '↻ Replay build';
    btn.addEventListener( 'click', playBuild );
    container.appendChild( btn );
  }

  function renderLoop() {
    if ( ! running ) return;
    requestAnimationFrame( renderLoop );
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
