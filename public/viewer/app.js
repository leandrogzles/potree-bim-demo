/**
 * Potree + BIM Viewer
 * Integrates Potree point cloud viewer with Three.js BIM (GLB) models
 * With full diagnostics, lighting, and alignment tools
 */

(function() {
  'use strict';

  const CONFIG = {
    api: {
      pointclouds: '/api/pointclouds',
      pointcloudEnsure: '/api/pointclouds/ensure',
      pointcloudDebug: '/api/pointclouds/debug',
      bimModels: '/api/bim-models',
      alignment: '/api/alignment',
      ifcEnsureGlb: '/api/ifc/ensure-glb',
      mockProperties: '/api/mock-properties',
    },
    defaultPointBudget: 2_000_000,
    nudgeSteps: {
      1: { translate: 0.01, rotate: 0.5, scale: 0.01 },
      2: { translate: 0.1, rotate: 5, scale: 0.1 },
      3: { translate: 1.0, rotate: 15, scale: 0.5 },
    },
    defaultBimUnits: 'm',
    unitsScale: {
      'm': 1.0,
      'mm': 0.001,
      'cm': 0.01,
      'ft': 0.3048,
      'in': 0.0254,
    },
  };

  const state = {
    viewer: null,
    currentPointCloud: null,
    currentCloudId: null,
    currentCloudJsUrl: null,
    
    currentBimRoot: null,
    currentModelId: null,
    currentModelType: null,
    originalBimMaterials: new Map(),
    forceUnlitEnabled: false,
    
    debugHelpers: {
      cloudMarker: null,
      bimMarker: null,
      axesHelper: null,
      gridHelper: null,
      lights: {
        ambient: null,
        directional: null,
        hemisphere: null,
      },
    },

    pointclouds: [],
    bimModels: [],
    
    loadToken: 0,
    cloudLoadToken: 0,
    currentStep: 2,
    currentUnits: 'm',
    initialized: false,
    isConverting: false,

    // Selection state (ENTREGA 2 - Enhanced)
    selection: {
      objectRoot: null,
      hitObject: null,
      selectionKey: null,
      objectName: null,
      objectUuid: null,
      pseudoDbId: null,
    },
    lastClickCoords: null,
    selectionPanelVisible: false,
    selectionPinned: false,
    cachedProperties: null,
    propertiesCache: new Map(),
    collapsedGroups: new Set(),
    hiddenObjects: new Set(),
    isolatedObject: null,
    searchQuery: '',
  };

  function debugLog(message, type = 'info') {
    const logEl = document.getElementById('debug-log');
    if (logEl) {
      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      const timestamp = new Date().toLocaleTimeString();
      entry.textContent = `[${timestamp}] ${message}`;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }
    console.log(`[Viewer:${type}] ${message}`);
  }

  function showLoading(message) {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (overlay) overlay.classList.remove('hidden');
    if (text) text.textContent = message || 'Loading...';
  }

  function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function showError(message) {
    const banner = document.getElementById('error-banner');
    if (banner) {
      banner.textContent = message;
      banner.classList.remove('hidden');
      setTimeout(() => banner.classList.add('hidden'), 8000);
    }
    debugLog(message, 'error');
  }

  function showStatus(message, type = 'info') {
    const container = document.getElementById('status-container');
    if (container) {
      container.innerHTML = `<div class="status-message ${type}">${message}</div>`;
      setTimeout(() => container.innerHTML = '', 5000);
    }
    debugLog(message, type);
  }

  function updateInfo(id, value) {
    const el = document.getElementById(`info-${id}`);
    if (el) el.textContent = value || '-';
  }

  function setLoadButtonEnabled(enabled) {
    const btn = document.getElementById('btn-load');
    if (btn) {
      btn.disabled = !enabled;
      btn.textContent = enabled ? 'Load Selected' : 'Converting...';
    }
  }

  function getBoxInfo(box) {
    if (!box || box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    return { center, size, min: box.min.clone(), max: box.max.clone() };
  }

  function getCloudBoundingBox() {
    if (!state.currentPointCloud) return null;
    const bb = state.currentPointCloud.boundingBox;
    if (!bb) return null;
    
    const box = new THREE.Box3(bb.min.clone(), bb.max.clone());
    const position = state.currentPointCloud.position;
    box.min.add(position);
    box.max.add(position);
    return box;
  }

  function getBimBoundingBox() {
    if (!state.currentBimRoot) return null;
    const box = new THREE.Box3().setFromObject(state.currentBimRoot);
    return box.isEmpty() ? null : box;
  }

  function logBoundingBoxInfo(name, box) {
    const info = getBoxInfo(box);
    if (!info) {
      debugLog(`${name} bbox: (empty or null)`);
      return null;
    }
    debugLog(`${name} bbox min: (${info.min.x.toFixed(2)}, ${info.min.y.toFixed(2)}, ${info.min.z.toFixed(2)})`);
    debugLog(`${name} bbox max: (${info.max.x.toFixed(2)}, ${info.max.y.toFixed(2)}, ${info.max.z.toFixed(2)})`);
    debugLog(`${name} center: (${info.center.x.toFixed(2)}, ${info.center.y.toFixed(2)}, ${info.center.z.toFixed(2)})`);
    debugLog(`${name} size: ${info.size.x.toFixed(2)} x ${info.size.y.toFixed(2)} x ${info.size.z.toFixed(2)}`);
    return info;
  }

  function setupLights() {
    const scene = state.viewer.scene.scene;
    
    if (!state.debugHelpers.lights.ambient) {
      const ambient = new THREE.AmbientLight(0xffffff, 0.6);
      ambient.name = 'bimAmbientLight';
      scene.add(ambient);
      state.debugHelpers.lights.ambient = ambient;
      debugLog('Added AmbientLight (intensity: 0.6)');
    }
    
    if (!state.debugHelpers.lights.directional) {
      const directional = new THREE.DirectionalLight(0xffffff, 0.8);
      directional.name = 'bimDirectionalLight';
      directional.position.set(100, 100, 100);
      scene.add(directional);
      state.debugHelpers.lights.directional = directional;
      debugLog('Added DirectionalLight (intensity: 0.8)');
    }
    
    if (!state.debugHelpers.lights.hemisphere) {
      const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
      hemisphere.name = 'bimHemisphereLight';
      scene.add(hemisphere);
      state.debugHelpers.lights.hemisphere = hemisphere;
      debugLog('Added HemisphereLight (intensity: 0.4)');
    }
  }

  function setupDebugHelpers() {
    const scene = state.viewer.scene.scene;
    
    if (!state.debugHelpers.axesHelper) {
      const axes = new THREE.AxesHelper(50);
      axes.name = 'debugAxes';
      scene.add(axes);
      state.debugHelpers.axesHelper = axes;
    }
    
    if (!state.debugHelpers.gridHelper) {
      const grid = new THREE.GridHelper(200, 50, 0x444444, 0x222222);
      grid.name = 'debugGrid';
      scene.add(grid);
      state.debugHelpers.gridHelper = grid;
    }
  }

  function updateDebugMarkers() {
    const scene = state.viewer.scene.scene;
    
    if (state.debugHelpers.cloudMarker) {
      scene.remove(state.debugHelpers.cloudMarker);
      state.debugHelpers.cloudMarker = null;
    }
    if (state.debugHelpers.bimMarker) {
      scene.remove(state.debugHelpers.bimMarker);
      state.debugHelpers.bimMarker = null;
    }
    
    const cloudBox = getCloudBoundingBox();
    if (cloudBox) {
      const cloudInfo = getBoxInfo(cloudBox);
      if (cloudInfo) {
        const markerSize = Math.max(cloudInfo.size.x, cloudInfo.size.y, cloudInfo.size.z) * 0.02;
        const geometry = new THREE.SphereGeometry(Math.max(markerSize, 0.5), 16, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.8 });
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(cloudInfo.center);
        marker.name = 'cloudCenterMarker';
        scene.add(marker);
        state.debugHelpers.cloudMarker = marker;
      }
    }
    
    const bimBox = getBimBoundingBox();
    if (bimBox) {
      const bimInfo = getBoxInfo(bimBox);
      if (bimInfo) {
        const markerSize = Math.max(bimInfo.size.x, bimInfo.size.y, bimInfo.size.z) * 0.02;
        const geometry = new THREE.SphereGeometry(Math.max(markerSize, 0.5), 16, 16);
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.8 });
        const marker = new THREE.Mesh(geometry, material);
        marker.position.copy(bimInfo.center);
        marker.name = 'bimCenterMarker';
        scene.add(marker);
        state.debugHelpers.bimMarker = marker;
      }
    }
  }

  function setForceUnlit(enabled) {
    if (!state.currentBimRoot) return;
    
    state.forceUnlitEnabled = enabled;
    
    if (enabled) {
      state.currentBimRoot.traverse((child) => {
        if (child.isMesh && child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          const newMaterials = [];
          
          materials.forEach((mat, idx) => {
            if (!state.originalBimMaterials.has(child.uuid + '_' + idx)) {
              state.originalBimMaterials.set(child.uuid + '_' + idx, mat);
            }
            
            let color = mat.color ? mat.color.clone() : new THREE.Color(0x888888);
            const basic = new THREE.MeshBasicMaterial({
              color: color,
              transparent: mat.transparent,
              opacity: mat.opacity,
              side: mat.side,
              wireframe: false,
            });
            newMaterials.push(basic);
          });
          
          child.material = newMaterials.length === 1 ? newMaterials[0] : newMaterials;
        }
      });
      debugLog('Force Unlit: ON (MeshBasicMaterial applied)', 'success');
    } else {
      state.currentBimRoot.traverse((child) => {
        if (child.isMesh) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          const originalMaterials = [];
          
          materials.forEach((mat, idx) => {
            const original = state.originalBimMaterials.get(child.uuid + '_' + idx);
            if (original) {
              originalMaterials.push(original);
            } else {
              originalMaterials.push(mat);
            }
          });
          
          child.material = originalMaterials.length === 1 ? originalMaterials[0] : originalMaterials;
        }
      });
      debugLog('Force Unlit: OFF (original materials restored)');
    }
  }

  function autoAlignBimToCloud() {
    const cloudBox = getCloudBoundingBox();
    const bimBox = getBimBoundingBox();
    
    if (!cloudBox || !bimBox || !state.currentBimRoot) {
      debugLog('Auto-align skipped: missing cloud or BIM');
      return false;
    }
    
    const cloudInfo = getBoxInfo(cloudBox);
    const bimInfo = getBoxInfo(bimBox);
    
    if (!cloudInfo || !bimInfo) return false;
    
    const delta = new THREE.Vector3().subVectors(cloudInfo.center, bimInfo.center);
    
    debugLog(`Auto-align delta: (${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}, ${delta.z.toFixed(2)})`);
    
    state.currentBimRoot.position.add(delta);
    state.currentBimRoot.updateMatrixWorld(true);
    
    updateTransformDisplay();
    updateDebugMarkers();
    
    debugLog('BIM auto-aligned to cloud center', 'success');
    return true;
  }

  function applyUnitsScale(units) {
    if (!state.currentBimRoot) return;
    
    const scale = CONFIG.unitsScale[units] || 1.0;
    state.currentUnits = units;
    
    state.currentBimRoot.scale.set(scale, scale, scale);
    state.currentBimRoot.updateMatrixWorld(true);
    
    debugLog(`Units scale applied: ${units} (scale: ${scale})`);
    updateTransformDisplay();
    updateDebugMarkers();
  }

  function compareScales() {
    const cloudBox = getCloudBoundingBox();
    const bimBox = getBimBoundingBox();
    
    if (!cloudBox || !bimBox) {
      debugLog('Cannot compare scales: missing cloud or BIM');
      return;
    }
    
    const cloudInfo = getBoxInfo(cloudBox);
    const bimInfo = getBoxInfo(bimBox);
    
    if (!cloudInfo || !bimInfo) return;
    
    const cloudMaxDim = Math.max(cloudInfo.size.x, cloudInfo.size.y, cloudInfo.size.z);
    const bimMaxDim = Math.max(bimInfo.size.x, bimInfo.size.y, bimInfo.size.z);
    
    const ratio = bimMaxDim / cloudMaxDim;
    
    debugLog(`=== Scale Comparison ===`);
    debugLog(`Cloud max dimension: ${cloudMaxDim.toFixed(2)}`);
    debugLog(`BIM max dimension: ${bimMaxDim.toFixed(2)}`);
    debugLog(`Ratio (BIM/Cloud): ${ratio.toFixed(4)}`);
    
    if (ratio > 500) {
      debugLog(`⚠️ BIM is ~${Math.round(ratio)}x larger than cloud - likely mm vs m issue`, 'warning');
      debugLog(`Try: Units = mm (scale 0.001)`, 'warning');
    } else if (ratio < 0.002) {
      debugLog(`⚠️ BIM is ~${Math.round(1/ratio)}x smaller than cloud - likely m vs mm issue`, 'warning');
      debugLog(`Try: Units = mm→m (scale 1000)`, 'warning');
    } else if (ratio > 10 || ratio < 0.1) {
      debugLog(`⚠️ Significant scale difference detected`, 'warning');
    } else {
      debugLog(`Scale appears reasonable`, 'success');
    }
  }

  function initPotreeViewer() {
    debugLog('Initializing Potree viewer...');
    
    if (typeof Potree === 'undefined') {
      showError('Potree library not loaded! Check network/CDN availability.');
      return false;
    }

    const baseUrl = window.location.origin;
    const potreeBase = baseUrl + '/libs/potree/Potree_1.8/build/potree/';
    
    Potree.resourcePath = potreeBase + 'resources/';
    Potree.scriptPath = potreeBase;
    
    debugLog('Potree resourcePath: ' + Potree.resourcePath);

    const viewerContainer = document.getElementById('potree_render_area');
    
    state.viewer = new Potree.Viewer(viewerContainer);
    
    state.viewer.setEDLEnabled(true);
    state.viewer.setFOV(60);
    state.viewer.setPointBudget(CONFIG.defaultPointBudget);
    state.viewer.setMinNodeSize(30);
    state.viewer.loadSettingsFromURL();
    state.viewer.setBackground('gradient');
    state.viewer.setControls(state.viewer.orbitControls);
    
    setupLights();
    setupDebugHelpers();
    
    debugLog('Potree viewer initialized with lights and helpers');
    debugLog(`Point budget: ${CONFIG.defaultPointBudget.toLocaleString()}`);
    
    state.initialized = true;
    return true;
  }

  async function fetchPointclouds() {
    try {
      const response = await fetch(CONFIG.api.pointclouds);
      const data = await response.json();
      state.pointclouds = data.pointclouds || [];
      debugLog(`Found ${state.pointclouds.length} point clouds`);
    } catch (error) {
      debugLog(`Failed to fetch pointclouds: ${error.message}`, 'error');
      state.pointclouds = [];
    }
  }

  async function fetchBimModels() {
    try {
      const response = await fetch(CONFIG.api.bimModels);
      const data = await response.json();
      state.bimModels = data.models || [];
      debugLog(`Found ${state.bimModels.length} BIM models`);
    } catch (error) {
      debugLog(`Failed to fetch BIM models: ${error.message}`, 'error');
      state.bimModels = [];
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function populateDropdowns() {
    const cloudSelect = document.getElementById('cloud-select');
    const bimSelect = document.getElementById('bim-select');

    cloudSelect.innerHTML = '<option value="">-- No Point Cloud --</option>';
    state.pointclouds.forEach(pc => {
      const option = document.createElement('option');
      option.value = pc.id;
      
      if (pc.type === 'potree' && pc.status === 'ready') {
        const countStr = pc.pointCount ? ` (${(pc.pointCount/1e6).toFixed(1)}M pts)` : '';
        option.textContent = `✓ ${pc.name}${countStr}`;
        option.dataset.cloudJs = pc.cloudJs;
      } else if (pc.type === 'raw') {
        const sizeStr = pc.bytes ? ` (${formatBytes(pc.bytes)})` : '';
        option.textContent = `⚙ ${pc.name}${sizeStr} [RAW]`;
        option.dataset.rawFileName = pc.rawFileName;
      }
      
      option.dataset.type = pc.type;
      option.dataset.status = pc.status;
      cloudSelect.appendChild(option);
    });

    bimSelect.innerHTML = '<option value="">-- No BIM Model --</option>';
    state.bimModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      option.dataset.modelId = model.id;
      option.dataset.type = model.type;
      option.dataset.source = model.source;
      
      if (model.type === 'glb') {
        option.dataset.urn = model.urn;
        option.dataset.runId = model.runId;
        option.dataset.glbUrl = model.glbUrl;
      } else if (model.type === 'ifc') {
        option.dataset.ifcId = model.ifcId;
        option.dataset.ifcUrl = model.ifcUrl;
      }
      
      bimSelect.appendChild(option);
    });
  }

  async function ensurePotreeCloud(id, rawFileName) {
    debugLog(`Ensuring Potree conversion for: ${id || rawFileName}`);
    updateInfo('cloud', 'Converting...');
    showLoading('Converting point cloud to Potree format...');
    state.isConverting = true;
    setLoadButtonEnabled(false);

    try {
      const body = id ? { id } : { rawFileName };
      
      const response = await fetch(CONFIG.api.pointcloudEnsure, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || result.error || 'Conversion failed');
      }

      debugLog(`Conversion complete: ${result.cloudId}`, 'success');
      debugLog(`Cloud.js URL: ${result.cloudJsUrl}`);
      
      if (result.pointCount) {
        debugLog(`Point count: ${result.pointCount.toLocaleString()}`);
      }
      
      showStatus(
        result.cached 
          ? 'Point cloud ready (cached)' 
          : `Point cloud converted (${Math.round(result.durationMs / 1000)}s)`,
        'success'
      );

      return result;
    } catch (error) {
      debugLog(`Conversion failed: ${error.message}`, 'error');
      throw error;
    } finally {
      state.isConverting = false;
      setLoadButtonEnabled(true);
      hideLoading();
    }
  }

  async function loadPointCloud(cloudJsUrl, cloudId) {
    const token = ++state.cloudLoadToken;
    
    debugLog(`Loading point cloud: ${cloudJsUrl}`);
    updateInfo('cloud', 'Loading...');
    showLoading('Loading point cloud...');

    if (state.currentPointCloud) {
      debugLog('Removing previous point cloud');
      state.viewer.scene.removePointCloud(state.currentPointCloud);
      state.currentPointCloud = null;
    }

    try {
      const testResponse = await fetch(cloudJsUrl, { method: 'HEAD' });
      if (!testResponse.ok) {
        throw new Error(`cloud.js not accessible: HTTP ${testResponse.status}`);
      }
      debugLog(`cloud.js accessible: HTTP ${testResponse.status}`, 'success');
      
      await new Promise((resolve, reject) => {
        Potree.loadPointCloud(cloudJsUrl, cloudId || 'pointcloud', function(e) {
          if (token !== state.cloudLoadToken) {
            debugLog('Point cloud load cancelled (superseded)');
            resolve();
            return;
          }

          if (!e || !e.pointcloud) {
            reject(new Error('Potree.loadPointCloud returned no pointcloud'));
            return;
          }

          const pc = e.pointcloud;
          state.currentPointCloud = pc;
          state.currentCloudId = cloudId;
          state.currentCloudJsUrl = cloudJsUrl;
          
          state.viewer.scene.addPointCloud(pc);
          
          pc.material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
          pc.material.size = 1.0;
          pc.material.minSize = 2;
          pc.material.maxSize = 50;
          pc.material.opacity = 1.0;
          pc.visible = true;
          
          if (pc.material.pointColorType !== undefined) {
            const hasRGB = pc.pointAttributes && 
              (pc.pointAttributes.attributes.some(a => a.name === 'rgba' || a.name === 'rgb'));
            
            if (hasRGB) {
              pc.material.activeAttributeName = 'rgba';
              debugLog('Using RGB colors');
            } else {
              pc.material.activeAttributeName = 'elevation';
              debugLog('Using elevation colors (no RGB data)');
            }
          }
          
          const budgetEl = document.getElementById('point-budget');
          const budget = budgetEl ? parseFloat(budgetEl.value) * 1_000_000 : CONFIG.defaultPointBudget;
          state.viewer.setPointBudget(budget);
          state.viewer.setEDLEnabled(document.getElementById('edl-enabled')?.checked ?? true);
          
          debugLog('=== Point Cloud Loaded ===');
          const cloudBox = getCloudBoundingBox();
          logBoundingBoxInfo('Cloud', cloudBox);
          
          const numPoints = pc.numPoints || (pc.pcoGeometry && pc.pcoGeometry.numPoints) || 'unknown';
          debugLog(`Point count: ${typeof numPoints === 'number' ? numPoints.toLocaleString() : numPoints}`, 'success');
          updateInfo('cloud', `${cloudId}`);
          updateInfo('points', typeof numPoints === 'number' ? numPoints.toLocaleString() : numPoints);
          
          updateDebugMarkers();
          
          if (!state.currentBimRoot) {
            state.viewer.fitToScreen();
          } else {
            focusBoth();
          }
          
          resolve();
        });
      });

    } catch (error) {
      debugLog(`Failed to load point cloud: ${error.message}`, 'error');
      showError(`Failed to load point cloud: ${error.message}`);
      updateInfo('cloud', 'Failed');
    } finally {
      hideLoading();
    }
  }

  async function ensureIfcGlb(ifcId) {
    debugLog(`Ensuring GLB for IFC: ${ifcId}`);
    updateInfo('bim', 'Converting IFC...');
    showLoading('Converting IFC to GLB...');

    try {
      const response = await fetch(CONFIG.api.ifcEnsureGlb, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ifcId, quality: 'balanced' }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || result.error || 'IFC conversion failed');
      }

      debugLog('IFC converted successfully', 'success');
      return result;
    } catch (error) {
      debugLog(`IFC conversion failed: ${error.message}`, 'error');
      throw error;
    }
  }

  function unloadBim() {
    if (!state.currentBimRoot) return;

    if (state.selection.objectRoot) {
      clearSelection(true);
    }
    
    state.hiddenObjects.clear();
    state.isolatedObject = null;
    state.propertiesCache.clear();
    updateHiddenCounter();

    debugLog('Unloading BIM model');
    state.viewer.scene.scene.remove(state.currentBimRoot);

    state.currentBimRoot.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });

    state.currentBimRoot = null;
    state.currentModelId = null;
    state.currentModelType = null;
    state.originalBimMaterials.clear();
    state.forceUnlitEnabled = false;
    
    const unlitCheckbox = document.getElementById('force-unlit');
    if (unlitCheckbox) unlitCheckbox.checked = false;
    
    updateInfo('bim', 'Not loaded');
    updateTransformDisplay();
    updateDebugMarkers();
  }

  async function loadGlb(glbUrl, modelId, displayName) {
    const token = ++state.loadToken;

    showLoading('Loading BIM model...');
    updateInfo('bim', 'Loading...');
    debugLog(`Loading GLB: ${glbUrl}`);

    try {
      if (!THREE.GLTFLoader) {
        throw new Error('THREE.GLTFLoader not available. Check if GLTFLoader script loaded correctly.');
      }
      const loader = new THREE.GLTFLoader();

      const gltf = await new Promise((resolve, reject) => {
        loader.load(
          glbUrl,
          resolve,
          (progress) => {
            if (progress.total > 0) {
              const pct = Math.round((progress.loaded / progress.total) * 100);
              updateInfo('bim', `Loading ${pct}%`);
            }
          },
          reject
        );
      });

      if (token !== state.loadToken) {
        debugLog('BIM load cancelled (superseded)');
        return;
      }

      state.currentBimRoot = new THREE.Group();
      state.currentBimRoot.name = 'bimRoot';
      state.currentBimRoot.add(gltf.scene);
      
      state.viewer.scene.scene.add(state.currentBimRoot);
      state.currentModelId = modelId;

      debugLog('=== BIM Model Loaded (raw) ===');
      const rawBimBox = getBimBoundingBox();
      logBoundingBoxInfo('BIM (raw)', rawBimBox);
      
      let meshCount = 0;
      let materialTypes = new Set();
      state.currentBimRoot.traverse((child) => {
        if (child.isMesh) {
          meshCount++;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => materialTypes.add(m.type));
        }
      });
      debugLog(`Mesh count: ${meshCount}`);
      debugLog(`Material types: ${Array.from(materialTypes).join(', ')}`);
      
      const unitsSelect = document.getElementById('bim-units');
      const units = unitsSelect ? unitsSelect.value : CONFIG.defaultBimUnits;
      if (units !== 'm') {
        applyUnitsScale(units);
      }
      
      const alignmentApplied = await loadAndApplyAlignment(modelId);
      
      if (!alignmentApplied && state.currentPointCloud) {
        debugLog('No saved alignment - applying auto-align by centers', 'warning');
        autoAlignBimToCloud();
        showStatus('Auto-aligned BIM to cloud center (no saved alignment)', 'warning');
      }
      
      compareScales();
      
      debugLog('=== BIM After Transforms ===');
      const finalBimBox = getBimBoundingBox();
      logBoundingBoxInfo('BIM (final)', finalBimBox);
      
      debugLog(`BIM position: (${state.currentBimRoot.position.x.toFixed(2)}, ${state.currentBimRoot.position.y.toFixed(2)}, ${state.currentBimRoot.position.z.toFixed(2)})`);
      debugLog(`BIM scale: (${state.currentBimRoot.scale.x.toFixed(4)}, ${state.currentBimRoot.scale.y.toFixed(4)}, ${state.currentBimRoot.scale.z.toFixed(4)})`);

      debugLog('BIM model loaded successfully', 'success');
      updateInfo('bim', displayName || 'Loaded');
      updateTransformDisplay();
      updateDebugMarkers();

      const showBimCheckbox = document.getElementById('show-bim');
      if (showBimCheckbox) {
        state.currentBimRoot.visible = showBimCheckbox.checked;
      }
      
      if (state.currentPointCloud) {
        focusBoth();
      } else {
        focusBim();
      }

    } catch (error) {
      debugLog(`BIM load failed: ${error.message}`, 'error');
      showError(`Failed to load BIM: ${error.message}`);
      updateInfo('bim', 'Failed');
    }

    hideLoading();
  }

  async function loadAndApplyAlignment(modelId) {
    try {
      const response = await fetch(`${CONFIG.api.alignment}?modelId=${encodeURIComponent(modelId)}`);
      const alignment = await response.json();

      if (state.currentBimRoot && alignment.matrix && !alignment.isDefault) {
        const matrix = new THREE.Matrix4();
        matrix.fromArray(alignment.matrix);
        
        state.currentBimRoot.position.set(0, 0, 0);
        state.currentBimRoot.rotation.set(0, 0, 0);
        state.currentBimRoot.scale.set(1, 1, 1);
        state.currentBimRoot.updateMatrix();
        
        state.currentBimRoot.applyMatrix4(matrix);
        state.currentBimRoot.updateMatrixWorld(true);
        
        debugLog('Saved alignment matrix applied', 'success');
        return true;
      } else {
        debugLog('No saved alignment found (using identity)');
        return false;
      }
    } catch (error) {
      debugLog(`Failed to load alignment: ${error.message}`, 'error');
      return false;
    }
  }

  async function loadSelected() {
    if (state.isConverting) {
      debugLog('Conversion in progress, ignoring load request');
      return;
    }

    const cloudSelect = document.getElementById('cloud-select');
    const bimSelect = document.getElementById('bim-select');
    
    const selectedCloud = cloudSelect.selectedOptions[0];
    const selectedBim = bimSelect.selectedOptions[0];

    const cloudValue = selectedCloud?.value || null;
    const cloudType = selectedCloud?.dataset?.type;
    const cloudStatus = selectedCloud?.dataset?.status;

    const params = new URLSearchParams();
    if (cloudValue) params.set('cloudId', cloudValue);
    
    if (cloudValue) {
      try {
        let cloudJsUrl = null;
        let cloudId = null;
        
        if (cloudType === 'raw' || cloudStatus === 'needs_convert') {
          const rawFileName = selectedCloud.dataset.rawFileName;
          const result = await ensurePotreeCloud(cloudValue, rawFileName);
          cloudJsUrl = result.cloudJsUrl;
          cloudId = result.cloudId;
          
          await fetchPointclouds();
          populateDropdowns();
        } else if (cloudType === 'potree' && cloudStatus === 'ready') {
          cloudJsUrl = selectedCloud.dataset.cloudJs;
          cloudId = cloudValue.replace('pc:potree:', '');
        }

        if (cloudJsUrl && (cloudId !== state.currentCloudId || !state.currentPointCloud)) {
          await loadPointCloud(cloudJsUrl, cloudId);
        }
      } catch (error) {
        showError(`Failed to process point cloud: ${error.message}`);
        updateInfo('cloud', 'Failed');
      }
    } else {
      if (state.currentPointCloud) {
        debugLog('Removing point cloud (none selected)');
        state.viewer.scene.removePointCloud(state.currentPointCloud);
        state.currentPointCloud = null;
        state.currentCloudId = null;
        state.currentCloudJsUrl = null;
        updateDebugMarkers();
      }
      updateInfo('cloud', 'Not loaded');
      updateInfo('points', '-');
    }

    if (selectedBim && selectedBim.value) {
      const modelId = selectedBim.dataset.modelId;
      const type = selectedBim.dataset.type;

      if (modelId) params.set('modelId', modelId);

      if (state.currentModelId !== modelId) {
        unloadBim();

        try {
          if (type === 'glb') {
            const glbUrl = selectedBim.dataset.glbUrl;
            const runId = selectedBim.dataset.runId;
            await loadGlb(glbUrl, modelId, `Loaded (${runId?.substring(0, 8) || 'APS'}...)`);
            state.currentModelType = 'glb';
          } else if (type === 'ifc') {
            const ifcId = selectedBim.dataset.ifcId;
            const result = await ensureIfcGlb(ifcId);
            await loadGlb(result.glbUrl, modelId, `Loaded (IFC)`);
            state.currentModelType = 'ifc';
          }
        } catch (error) {
          showError(`Failed to load model: ${error.message}`);
          updateInfo('bim', 'Failed');
          hideLoading();
        }
      }
    } else {
      unloadBim();
    }

    history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }

  function focusCloud() {
    if (!state.currentPointCloud) {
      showStatus('No point cloud loaded', 'warning');
      return;
    }
    state.viewer.fitToScreen();
    showStatus('Focused on point cloud', 'info');
  }

  function focusBim() {
    if (!state.currentBimRoot) {
      showStatus('No BIM model loaded', 'warning');
      return;
    }

    const box = getBimBoundingBox();
    if (!box) {
      showStatus('BIM model has no geometry', 'warning');
      return;
    }

    const info = getBoxInfo(box);
    const maxDim = Math.max(info.size.x, info.size.y, info.size.z);
    const distance = maxDim * 2;

    const camera = state.viewer.scene.getActiveCamera();
    const controls = state.viewer.orbitControls;
    
    if (controls && controls.target) {
      controls.target.copy(info.center);
    }
    
    camera.position.set(
      info.center.x + distance * 0.7,
      info.center.y + distance * 0.5,
      info.center.z + distance * 0.7
    );
    
    camera.near = Math.max(0.1, maxDim * 0.001);
    camera.far = Math.max(10000, maxDim * 100);
    camera.updateProjectionMatrix();
    
    showStatus('Focused on BIM model', 'info');
  }

  function focusBoth() {
    const cloudBox = getCloudBoundingBox();
    const bimBox = getBimBoundingBox();
    
    if (!cloudBox && !bimBox) {
      showStatus('Nothing to focus on', 'warning');
      return;
    }
    
    let unionBox = new THREE.Box3();
    if (cloudBox) unionBox.union(cloudBox);
    if (bimBox) unionBox.union(bimBox);
    
    const info = getBoxInfo(unionBox);
    if (!info) {
      state.viewer.fitToScreen();
      return;
    }
    
    const maxDim = Math.max(info.size.x, info.size.y, info.size.z);
    const distance = maxDim * 1.5;

    const camera = state.viewer.scene.getActiveCamera();
    const controls = state.viewer.orbitControls;
    
    if (controls && controls.target) {
      controls.target.copy(info.center);
    }
    
    camera.position.set(
      info.center.x + distance * 0.7,
      info.center.y + distance * 0.5,
      info.center.z + distance * 0.7
    );
    
    camera.near = Math.max(0.1, maxDim * 0.001);
    camera.far = Math.max(10000, maxDim * 100);
    camera.updateProjectionMatrix();
    
    showStatus('Focused on all content', 'info');
  }

  function resetCamera() {
    const camera = state.viewer.scene.getActiveCamera();
    const controls = state.viewer.orbitControls;
    
    if (controls && controls.target) {
      controls.target.set(0, 0, 0);
    }
    camera.position.set(30, 30, 30);
    
    showStatus('Camera reset', 'info');
  }

  function setPointCloudVisible(visible) {
    if (state.currentPointCloud) {
      state.currentPointCloud.visible = visible;
      debugLog(`Point cloud visibility: ${visible}`);
    }
  }

  function setBimVisible(visible) {
    if (state.currentBimRoot) {
      state.currentBimRoot.visible = visible;
      debugLog(`BIM visibility: ${visible}`);
    }
  }

  function setBimOpacity(opacity) {
    if (!state.currentBimRoot) return;

    state.currentBimRoot.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          mat.transparent = opacity < 1;
          mat.opacity = opacity;
          mat.needsUpdate = true;
        });
      }
    });
  }

  function updateTransformDisplay() {
    const root = state.currentBimRoot;
    
    const posX = document.getElementById('pos-x');
    const posY = document.getElementById('pos-y');
    const posZ = document.getElementById('pos-z');
    const rotX = document.getElementById('rot-x');
    const rotY = document.getElementById('rot-y');
    const rotZ = document.getElementById('rot-z');
    const scaleDisplay = document.getElementById('scale-display');
    
    if (posX) posX.value = root ? root.position.x.toFixed(2) : '0.00';
    if (posY) posY.value = root ? root.position.y.toFixed(2) : '0.00';
    if (posZ) posZ.value = root ? root.position.z.toFixed(2) : '0.00';
    if (rotX) rotX.value = root ? (root.rotation.x * 180 / Math.PI).toFixed(1) : '0.0';
    if (rotY) rotY.value = root ? (root.rotation.y * 180 / Math.PI).toFixed(1) : '0.0';
    if (rotZ) rotZ.value = root ? (root.rotation.z * 180 / Math.PI).toFixed(1) : '0.0';
    if (scaleDisplay) scaleDisplay.value = root ? root.scale.x.toFixed(4) : '1.0000';
  }

  function applyManualTransform() {
    if (!state.currentBimRoot) return;
    
    const posX = parseFloat(document.getElementById('pos-x')?.value) || 0;
    const posY = parseFloat(document.getElementById('pos-y')?.value) || 0;
    const posZ = parseFloat(document.getElementById('pos-z')?.value) || 0;
    const rotX = (parseFloat(document.getElementById('rot-x')?.value) || 0) * Math.PI / 180;
    const rotY = (parseFloat(document.getElementById('rot-y')?.value) || 0) * Math.PI / 180;
    const rotZ = (parseFloat(document.getElementById('rot-z')?.value) || 0) * Math.PI / 180;
    const scale = parseFloat(document.getElementById('scale-display')?.value) || 1;
    
    state.currentBimRoot.position.set(posX, posY, posZ);
    state.currentBimRoot.rotation.set(rotX, rotY, rotZ);
    state.currentBimRoot.scale.set(scale, scale, scale);
    state.currentBimRoot.updateMatrixWorld(true);
    
    updateDebugMarkers();
    debugLog(`Manual transform applied: pos(${posX.toFixed(2)}, ${posY.toFixed(2)}, ${posZ.toFixed(2)}) rot(${(rotX*180/Math.PI).toFixed(1)}°, ${(rotY*180/Math.PI).toFixed(1)}°, ${(rotZ*180/Math.PI).toFixed(1)}°) scale(${scale.toFixed(4)})`);
  }

  function nudgePosition(axis, direction) {
    if (!state.currentBimRoot) return;

    const step = CONFIG.nudgeSteps[state.currentStep].translate;
    state.currentBimRoot.position[axis] += direction * step;
    state.currentBimRoot.updateMatrixWorld(true);
    updateTransformDisplay();
    updateDebugMarkers();
  }

  function nudgeRotation(axis, direction) {
    if (!state.currentBimRoot) return;

    const step = CONFIG.nudgeSteps[state.currentStep].rotate;
    state.currentBimRoot.rotation[axis] += direction * step * (Math.PI / 180);
    state.currentBimRoot.updateMatrixWorld(true);
    updateTransformDisplay();
    updateDebugMarkers();
  }

  function nudgeScale(direction) {
    if (!state.currentBimRoot) return;

    const step = CONFIG.nudgeSteps[state.currentStep].scale;
    const factor = direction > 0 ? (1 + step) : (1 - step);
    
    state.currentBimRoot.scale.multiplyScalar(factor);
    state.currentBimRoot.updateMatrixWorld(true);
    updateTransformDisplay();
    updateDebugMarkers();
    
    debugLog(`Scale adjusted by ${(factor * 100 - 100).toFixed(1)}%`);
  }

  function resetTransform() {
    if (!state.currentBimRoot) return;

    state.currentBimRoot.position.set(0, 0, 0);
    state.currentBimRoot.rotation.set(0, 0, 0);
    
    const unitsSelect = document.getElementById('bim-units');
    const units = unitsSelect ? unitsSelect.value : 'm';
    const scale = CONFIG.unitsScale[units] || 1.0;
    state.currentBimRoot.scale.set(scale, scale, scale);
    
    state.currentBimRoot.updateMatrixWorld(true);
    updateTransformDisplay();
    updateDebugMarkers();
    showStatus('Transform reset (with units scale)', 'info');
  }

  async function saveAlignment() {
    if (!state.currentBimRoot) {
      showStatus('No BIM model loaded', 'error');
      debugLog('Save alignment failed: No BIM model loaded', 'error');
      return;
    }
    
    if (!state.currentModelId) {
      showStatus('No model ID available', 'error');
      debugLog('Save alignment failed: state.currentModelId is null/undefined', 'error');
      return;
    }

    state.currentBimRoot.updateMatrix();
    const matrix = state.currentBimRoot.matrix.toArray();

    const payload = {
      modelId: state.currentModelId,
      matrix: matrix,
      units: state.currentUnits || 'm',
    };

    debugLog(`Saving alignment for modelId: ${state.currentModelId}`);
    debugLog(`Matrix: [${matrix.slice(0,4).map(n => n.toFixed(3)).join(', ')}, ...]`);
    console.log('[Alignment] Full payload:', payload);

    try {
      const response = await fetch(CONFIG.api.alignment, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let result;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        result = await response.json();
      } else {
        const text = await response.text();
        result = { error: text || `HTTP ${response.status}` };
      }

      if (!response.ok) {
        const errMsg = result.message || result.error || (result.details ? JSON.stringify(result.details) : `HTTP ${response.status}`);
        throw new Error(errMsg);
      }

      showStatus('Alignment saved!', 'success');
      debugLog('Alignment matrix saved to server', 'success');
    } catch (error) {
      showStatus(`Failed to save: ${error.message}`, 'error');
      debugLog(`Save alignment failed: ${error.message}`, 'error');
      console.error('[Alignment] Save error:', error);
    }
  }

  function runFullDiagnostics() {
    debugLog('========== FULL DIAGNOSTICS ==========');
    
    debugLog('--- Point Cloud ---');
    const cloudBox = getCloudBoundingBox();
    if (cloudBox) {
      logBoundingBoxInfo('Cloud', cloudBox);
    } else {
      debugLog('No point cloud loaded');
    }
    
    debugLog('--- BIM Model ---');
    const bimBox = getBimBoundingBox();
    if (bimBox) {
      logBoundingBoxInfo('BIM', bimBox);
      debugLog(`BIM position: (${state.currentBimRoot.position.x.toFixed(2)}, ${state.currentBimRoot.position.y.toFixed(2)}, ${state.currentBimRoot.position.z.toFixed(2)})`);
      debugLog(`BIM rotation: (${(state.currentBimRoot.rotation.x * 180/Math.PI).toFixed(1)}°, ${(state.currentBimRoot.rotation.y * 180/Math.PI).toFixed(1)}°, ${(state.currentBimRoot.rotation.z * 180/Math.PI).toFixed(1)}°)`);
      debugLog(`BIM scale: (${state.currentBimRoot.scale.x.toFixed(4)}, ${state.currentBimRoot.scale.y.toFixed(4)}, ${state.currentBimRoot.scale.z.toFixed(4)})`);
      
      let meshCount = 0;
      let materialTypes = {};
      state.currentBimRoot.traverse((child) => {
        if (child.isMesh) {
          meshCount++;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(m => {
            materialTypes[m.type] = (materialTypes[m.type] || 0) + 1;
          });
        }
      });
      debugLog(`Meshes: ${meshCount}`);
      debugLog(`Materials: ${JSON.stringify(materialTypes)}`);
    } else {
      debugLog('No BIM loaded');
    }
    
    debugLog('--- Scale Comparison ---');
    if (cloudBox && bimBox) {
      compareScales();
    }
    
    debugLog('--- Lights ---');
    debugLog(`Ambient: ${state.debugHelpers.lights.ambient ? 'YES' : 'NO'}`);
    debugLog(`Directional: ${state.debugHelpers.lights.directional ? 'YES' : 'NO'}`);
    debugLog(`Hemisphere: ${state.debugHelpers.lights.hemisphere ? 'YES' : 'NO'}`);
    
    debugLog('--- Camera ---');
    const camera = state.viewer.scene.getActiveCamera();
    debugLog(`Camera position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`);
    debugLog(`Camera near: ${camera.near}, far: ${camera.far}`);
    
    debugLog('========================================');
  }

  // ============================================================================
  // ENTREGA 2: Robust Selection + Advanced Properties Panel
  // ============================================================================

  const INSIGNIFICANT_NAME_PATTERNS = [
    /^mesh_?\d*$/i,
    /^object_?\d*$/i,
    /^group_?\d*$/i,
    /^node_?\d*$/i,
    /^primitive\d*$/i,
    /^submesh\d*$/i,
    /^_\d+$/,
    /^\d+$/,
  ];

  function isSignificantName(name) {
    if (!name || name.length === 0) return false;
    if (name === 'Scene' || name === 'RootNode' || name === 'bimRoot') return false;
    for (const pattern of INSIGNIFICANT_NAME_PATTERNS) {
      if (pattern.test(name)) return false;
    }
    return true;
  }

  function isContainerNode(obj) {
    if (!obj) return false;
    const name = obj.name || '';
    if (name === 'Scene' || name === 'RootNode' || name === 'bimRoot') return true;
    if (obj === state.currentBimRoot) return true;
    if (obj.parent === state.currentBimRoot && !obj.isMesh) {
      let meshCount = 0;
      obj.traverse((c) => { if (c.isMesh) meshCount++; });
      if (meshCount > 50) return true;
    }
    return false;
  }

  function findSelectionRoot(hitObject) {
    let current = hitObject;
    let bestCandidate = hitObject;

    console.log(`[Selection] Finding root for hit: ${hitObject.name || hitObject.uuid}`);

    while (current && current !== state.currentBimRoot) {
      if (isContainerNode(current)) {
        console.log(`[Selection] Skipping container node: ${current.name || current.uuid}`);
        current = current.parent;
        continue;
      }

      if (current.userData && current.userData.selectable === true) {
        console.log(`[Selection] Found userData.selectable on: ${current.name || current.uuid}`);
        return current;
      }

      if (isSignificantName(current.name)) {
        bestCandidate = current;
        console.log(`[Selection] Found significant name: ${current.name}`);
      }

      current = current.parent;
    }

    if (isContainerNode(bestCandidate)) {
      console.log(`[Selection] Best candidate is container, falling back to hitObject`);
      bestCandidate = hitObject;
    }

    console.log(`[Selection] Chosen root: ${bestCandidate.name || bestCandidate.uuid}`);
    return bestCandidate;
  }

  function applyHighlight(root) {
    if (!root) return;

    root.traverse((child) => {
      if (!child.isMesh || !child.material) return;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      
      materials.forEach((mat, idx) => {
        if (!child.userData.__highlightOrig) {
          child.userData.__highlightOrig = {};
        }
        
        const key = `mat_${idx}`;
        child.userData.__highlightOrig[key] = {
          hasEmissive: mat.emissive !== undefined,
          emissiveHex: mat.emissive ? mat.emissive.getHex() : 0,
          emissiveIntensity: mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 0,
          colorHex: mat.color ? mat.color.getHex() : 0xffffff,
          opacity: mat.opacity,
          transparent: mat.transparent,
        };

        if (mat.emissive !== undefined) {
          mat.emissive.setHex(0xffff00);
          mat.emissiveIntensity = 0.5;
        } else {
          mat.color.setHex(0xffff00);
          mat.transparent = true;
          mat.opacity = 0.7;
        }
        mat.needsUpdate = true;
      });
    });
  }

  function restoreHighlight(root) {
    if (!root) return;

    root.traverse((child) => {
      if (!child.isMesh || !child.material || !child.userData.__highlightOrig) return;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      
      materials.forEach((mat, idx) => {
        const key = `mat_${idx}`;
        const orig = child.userData.__highlightOrig[key];
        if (!orig) return;

        if (orig.hasEmissive && mat.emissive) {
          mat.emissive.setHex(orig.emissiveHex);
          mat.emissiveIntensity = orig.emissiveIntensity;
        } else if (mat.color) {
          mat.color.setHex(orig.colorHex);
          mat.transparent = orig.transparent;
          mat.opacity = orig.opacity;
        }
        mat.needsUpdate = true;
      });

      delete child.userData.__highlightOrig;
    });
  }

  function selectObject(objectRoot, hitObject, key) {
    if (state.selectionPinned && state.selection.objectRoot) {
      debugLog('Selection is pinned, ignoring new selection');
      return;
    }

    clearSelection(false);

    if (!objectRoot) return;

    applyHighlight(objectRoot);

    const pseudoDbId = simpleHashClient(key) % 1000000;

    state.selection = {
      objectRoot: objectRoot,
      hitObject: hitObject,
      selectionKey: key,
      objectName: objectRoot.name || '',
      objectUuid: objectRoot.uuid,
      pseudoDbId: pseudoDbId,
    };

    updateSelectionPanel();
    showSelectionPanel();
    showSelectionIndicator(true);

    debugLog(`Selected: ${key} (name: ${objectRoot.name || 'unnamed'}, dbId: ${pseudoDbId})`, 'success');
  }

  function simpleHashClient(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  function clearSelection(hidePanel = true) {
    const sel = state.selection;

    if (sel.objectRoot) {
      restoreHighlight(sel.objectRoot);
    }

    state.selection = {
      objectRoot: null,
      hitObject: null,
      selectionKey: null,
      objectName: null,
      objectUuid: null,
      pseudoDbId: null,
    };
    state.cachedProperties = null;
    state.searchQuery = '';

    const searchInput = document.getElementById('props-search');
    if (searchInput) searchInput.value = '';
    updateSearchClearButton();

    if (hidePanel) {
      hideSelectionPanel();
    }
    showSelectionIndicator(false);
    updateSelectionPanel();

    debugLog('Selection cleared');
  }

  function showSelectionPanel() {
    const panel = document.getElementById('selection-panel');
    if (panel) {
      panel.classList.add('visible');
      if (state.selectionPinned) {
        panel.classList.add('pinned');
      }
      state.selectionPanelVisible = true;
    }
  }

  function hideSelectionPanel() {
    const panel = document.getElementById('selection-panel');
    if (panel) {
      panel.classList.remove('visible');
      state.selectionPanelVisible = false;
    }
    const propsContainer = document.getElementById('props-container');
    if (propsContainer) propsContainer.innerHTML = '';
    const propsActions = document.getElementById('props-actions');
    if (propsActions) propsActions.style.display = 'none';
  }

  function showSelectionIndicator(show) {
    const indicator = document.getElementById('selection-indicator');
    if (indicator) {
      if (show) {
        indicator.classList.add('visible');
        setTimeout(() => indicator.classList.remove('visible'), 3000);
      } else {
        indicator.classList.remove('visible');
      }
    }
  }

  function toggleSelectionPin() {
    state.selectionPinned = !state.selectionPinned;
    const panel = document.getElementById('selection-panel');
    const pinBtn = document.getElementById('btn-pin-selection');
    
    if (panel) {
      panel.classList.toggle('pinned', state.selectionPinned);
    }
    if (pinBtn) {
      pinBtn.classList.toggle('active', state.selectionPinned);
    }
    
    debugLog(`Selection ${state.selectionPinned ? 'pinned' : 'unpinned'}`);
    showStatus(state.selectionPinned ? 'Selection pinned' : 'Selection unpinned', 'info');
  }

  function updateSelectionPanel() {
    const sel = state.selection;

    const keyEl = document.getElementById('sel-key');
    const nameEl = document.getElementById('sel-name');
    const dbIdEl = document.getElementById('sel-dbid');
    const meshCountEl = document.getElementById('sel-mesh-count');
    const lastClickEl = document.getElementById('sel-last-click');
    const sourceEl = document.getElementById('sel-source');

    if (keyEl) keyEl.textContent = sel.selectionKey || '-';
    if (nameEl) nameEl.textContent = sel.objectName || '(unnamed)';
    if (dbIdEl) dbIdEl.textContent = sel.pseudoDbId ? `#${sel.pseudoDbId}` : '-';

    if (meshCountEl) {
      if (state.currentBimRoot) {
        let count = 0;
        state.currentBimRoot.traverse((c) => { if (c.isMesh) count++; });
        meshCountEl.textContent = count.toString();
      } else {
        meshCountEl.textContent = '-';
      }
    }

    if (lastClickEl && state.lastClickCoords) {
      const c = state.lastClickCoords;
      lastClickEl.textContent = `(${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)})`;
    }

    if (sourceEl) {
      sourceEl.textContent = state.cachedProperties ? state.cachedProperties.source || 'mock' : '-';
    }

    const propsBtn = document.getElementById('btn-show-props');
    const hideBtn = document.getElementById('btn-hide-selected');
    const isolateBtn = document.getElementById('btn-isolate-selected');

    if (propsBtn) propsBtn.disabled = !sel.selectionKey;
    if (hideBtn) hideBtn.disabled = !sel.objectRoot;
    if (isolateBtn) isolateBtn.disabled = !sel.objectRoot;
  }

  async function fetchAndShowProperties() {
    const sel = state.selection;
    if (!sel.selectionKey) {
      debugLog('No selection to fetch properties for', 'warning');
      return;
    }

    const propsContainer = document.getElementById('props-container');
    const propsActions = document.getElementById('props-actions');
    if (!propsContainer) return;

    if (state.propertiesCache.has(sel.selectionKey)) {
      const cached = state.propertiesCache.get(sel.selectionKey);
      state.cachedProperties = cached;
      renderProperties(cached);
      if (propsActions) propsActions.style.display = 'block';
      debugLog(`Properties loaded from cache: ${sel.selectionKey}`, 'success');
      updateSelectionPanel();
      return;
    }

    propsContainer.innerHTML = '<div class="props-loading"><div class="spinner"></div>Loading properties...</div>';

    try {
      const url = `${CONFIG.api.mockProperties}?key=${encodeURIComponent(sel.selectionKey)}&name=${encodeURIComponent(sel.objectName || '')}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      state.cachedProperties = data;
      state.propertiesCache.set(sel.selectionKey, data);

      renderProperties(data);
      if (propsActions) propsActions.style.display = 'block';
      debugLog(`Properties loaded for: ${sel.selectionKey}`, 'success');
      updateSelectionPanel();

    } catch (error) {
      propsContainer.innerHTML = `<div class="props-error">Failed to load properties: ${error.message}</div>`;
      debugLog(`Failed to fetch properties: ${error.message}`, 'error');
    }
  }

  function renderProperties(data) {
    const propsContainer = document.getElementById('props-container');
    if (!propsContainer) return;

    if (!data.groups || data.groups.length === 0) {
      propsContainer.innerHTML = '<div class="no-selection">No properties available</div>';
      return;
    }

    let html = '';
    const query = state.searchQuery.toLowerCase();

    data.groups.forEach((group, groupIdx) => {
      const isCollapsed = state.collapsedGroups.has(group.group);
      const groupClass = isCollapsed ? 'props-group collapsed' : 'props-group';
      
      let hasVisibleProps = false;
      let propsHtml = '';

      group.props.forEach((prop) => {
        const matchesSearch = !query || 
          prop.name.toLowerCase().includes(query) || 
          (prop.value && prop.value.toLowerCase().includes(query));
        
        const rowClass = matchesSearch ? 'prop-row' : 'prop-row filtered-out';
        const highlight = query && matchesSearch ? ' highlight' : '';
        
        if (matchesSearch) hasVisibleProps = true;

        propsHtml += `<div class="${rowClass}${highlight}" data-name="${escapeHtml(prop.name)}" data-value="${escapeHtml(prop.value)}">`;
        propsHtml += `<span class="prop-name">${escapeHtml(prop.name)}</span>`;
        propsHtml += `<span class="prop-value">${escapeHtml(prop.value)}</span>`;
        propsHtml += `</div>`;
      });

      const groupVisibleClass = (query && !hasVisibleProps) ? ' filtered-out' : '';

      html += `<div class="${groupClass}${groupVisibleClass}" data-group="${escapeHtml(group.group)}">`;
      html += `<div class="props-group-header" onclick="window.togglePropsGroup('${escapeHtml(group.group)}')">`;
      html += `<div class="props-group-title"><span class="props-group-toggle">▼</span>${escapeHtml(group.group)}</div>`;
      html += `</div>`;
      html += `<div class="props-group-content">${propsHtml}</div>`;
      html += `</div>`;
    });

    const allFiltered = !html.includes('prop-row"') && !html.includes('prop-row highlight');
    if (query && allFiltered) {
      html += '<div class="no-results">No properties match your search</div>';
    }

    propsContainer.innerHTML = html;
  }

  function togglePropsGroup(groupName) {
    if (state.collapsedGroups.has(groupName)) {
      state.collapsedGroups.delete(groupName);
    } else {
      state.collapsedGroups.add(groupName);
    }

    const groupEl = document.querySelector(`.props-group[data-group="${groupName}"]`);
    if (groupEl) {
      groupEl.classList.toggle('collapsed');
    }
  }

  function filterProperties(query) {
    state.searchQuery = query;
    if (state.cachedProperties) {
      renderProperties(state.cachedProperties);
    }
    updateSearchClearButton();
  }

  function updateSearchClearButton() {
    const clearBtn = document.getElementById('btn-clear-search');
    if (clearBtn) {
      clearBtn.classList.toggle('visible', state.searchQuery.length > 0);
    }
  }

  function copySelectionKey() {
    const key = state.selection.selectionKey;
    if (!key) return;

    navigator.clipboard.writeText(key).then(() => {
      showStatus('Selection key copied to clipboard', 'success');
    }).catch(() => {
      showStatus('Failed to copy to clipboard', 'error');
    });
  }

  function copyPropertiesJson() {
    if (!state.cachedProperties) return;

    const json = JSON.stringify(state.cachedProperties, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      showStatus('Properties JSON copied to clipboard', 'success');
    }).catch(() => {
      showStatus('Failed to copy to clipboard', 'error');
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================================
  // ENTREGA 2: Hide / Isolate / Show All
  // ============================================================================

  function hideSelectedElement() {
    const sel = state.selection;
    if (!sel.objectRoot) {
      showStatus('No element selected', 'warning');
      return;
    }

    restoreHighlight(sel.objectRoot);
    sel.objectRoot.visible = false;
    state.hiddenObjects.add(sel.objectRoot.uuid);
    
    updateHiddenCounter();
    clearSelection(false);
    showStatus('Element hidden', 'info');
    debugLog(`Hidden: ${sel.selectionKey}`);
  }

  function isolateSelectedElement() {
    const sel = state.selection;
    if (!sel.objectRoot || !state.currentBimRoot) {
      showStatus('No element selected', 'warning');
      return;
    }

    state.hiddenObjects.clear();
    
    state.currentBimRoot.traverse((child) => {
      if (child === state.currentBimRoot) return;
      if (child === sel.objectRoot) return;
      
      let isDescendant = false;
      let parent = child.parent;
      while (parent) {
        if (parent === sel.objectRoot) {
          isDescendant = true;
          break;
        }
        parent = parent.parent;
      }

      if (!isDescendant && child.isMesh) {
        child.visible = false;
        state.hiddenObjects.add(child.uuid);
      }
    });

    sel.objectRoot.visible = true;
    sel.objectRoot.traverse((child) => {
      child.visible = true;
    });

    state.isolatedObject = sel.objectRoot;
    updateHiddenCounter();
    showStatus('Element isolated', 'info');
    debugLog(`Isolated: ${sel.selectionKey}`);
  }

  function showAllElements() {
    if (!state.currentBimRoot) return;

    state.currentBimRoot.traverse((child) => {
      child.visible = true;
    });

    state.hiddenObjects.clear();
    state.isolatedObject = null;
    updateHiddenCounter();
    showStatus('All elements visible', 'success');
    debugLog('All elements shown');
  }

  function updateHiddenCounter() {
    const counter = document.getElementById('hidden-counter');
    const countEl = document.getElementById('hidden-count');
    
    if (counter && countEl) {
      const count = state.hiddenObjects.size;
      countEl.textContent = count.toString();
      counter.classList.toggle('visible', count > 0);
    }
  }

  // ============================================================================
  // ENTREGA 2: Raycast and Event Handlers
  // ============================================================================

  function setupBimRaycast() {
    const renderArea = document.getElementById('potree_render_area');
    if (!renderArea) {
      debugLog('Cannot setup raycast: potree_render_area not found', 'error');
      return;
    }

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    renderArea.addEventListener('click', (event) => {
      if (!state.currentBimRoot || !state.viewer) return;

      if (state.selectionPinned && state.selection.objectRoot) {
        return;
      }

      const rect = renderArea.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const camera = state.viewer.scene.getActiveCamera();
      raycaster.setFromCamera(mouse, camera);

      const meshes = [];
      state.currentBimRoot.traverse((child) => {
        if (child.isMesh && child.visible) {
          meshes.push(child);
        }
      });

      const intersects = raycaster.intersectObjects(meshes, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const hitObject = hit.object;

        state.lastClickCoords = hit.point.clone();

        const selectionRoot = findSelectionRoot(hitObject);
        const selectionKey = selectionRoot.name || selectionRoot.uuid;

        selectObject(selectionRoot, hitObject, selectionKey);

        debugLog(`Raycast hit: mesh=${hitObject.name || hitObject.uuid}, root=${selectionRoot.name || selectionRoot.uuid}`);
      } else {
        debugLog('No BIM element hit');
        if (state.selectionPanelVisible && !state.selectionPinned) {
          showStatus('No BIM element under cursor', 'info');
        }
      }
    });

    debugLog('BIM raycast click handler setup complete');
  }

  function setupSelectionEventHandlers() {
    document.getElementById('btn-close-selection')?.addEventListener('click', () => {
      hideSelectionPanel();
    });

    document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
      state.selectionPinned = false;
      clearSelection(true);
    });

    document.getElementById('btn-show-props')?.addEventListener('click', () => {
      fetchAndShowProperties();
    });

    document.getElementById('btn-pin-selection')?.addEventListener('click', () => {
      toggleSelectionPin();
    });

    document.getElementById('btn-copy-key')?.addEventListener('click', () => {
      copySelectionKey();
    });

    document.getElementById('btn-copy-json')?.addEventListener('click', () => {
      copyPropertiesJson();
    });

    document.getElementById('btn-hide-selected')?.addEventListener('click', () => {
      hideSelectedElement();
    });

    document.getElementById('btn-isolate-selected')?.addEventListener('click', () => {
      isolateSelectedElement();
    });

    document.getElementById('btn-show-all')?.addEventListener('click', () => {
      showAllElements();
    });

    document.getElementById('btn-show-all-inline')?.addEventListener('click', (e) => {
      e.preventDefault();
      showAllElements();
    });

    const searchInput = document.getElementById('props-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        filterProperties(e.target.value);
      });
    }

    document.getElementById('btn-clear-search')?.addEventListener('click', () => {
      const searchInput = document.getElementById('props-search');
      if (searchInput) {
        searchInput.value = '';
        filterProperties('');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      if (e.key === 'Escape') {
        if (state.selectionPinned) {
          state.selectionPinned = false;
          const panel = document.getElementById('selection-panel');
          const pinBtn = document.getElementById('btn-pin-selection');
          if (panel) panel.classList.remove('pinned');
          if (pinBtn) pinBtn.classList.remove('active');
        }
        if (state.selectionPanelVisible) {
          clearSelection(true);
        }
      }

      if (e.key === 'h' || e.key === 'H') {
        hideSelectedElement();
      }

      if (e.key === 'i' || e.key === 'I') {
        isolateSelectedElement();
      }

      if (e.key === 'a' || e.key === 'A') {
        if (e.shiftKey) {
          showAllElements();
        }
      }
    });

    window.togglePropsGroup = togglePropsGroup;

    debugLog('Selection event handlers setup complete');
    debugLog('Keys: H=hide, I=isolate, Shift+A=show all, ESC=clear/unpin');
  }

  function setupEventHandlers() {
    document.getElementById('btn-load')?.addEventListener('click', loadSelected);

    document.getElementById('btn-refresh')?.addEventListener('click', async () => {
      showLoading('Refreshing...');
      await fetchPointclouds();
      await fetchBimModels();
      populateDropdowns();
      hideLoading();
      showStatus('Lists refreshed', 'info');
    });

    document.getElementById('btn-focus-cloud')?.addEventListener('click', focusCloud);
    document.getElementById('btn-focus-bim')?.addEventListener('click', focusBim);
    document.getElementById('btn-focus-both')?.addEventListener('click', focusBoth);
    document.getElementById('btn-reset-camera')?.addEventListener('click', resetCamera);

    document.getElementById('show-cloud')?.addEventListener('change', (e) => {
      setPointCloudVisible(e.target.checked);
    });

    document.getElementById('show-bim')?.addEventListener('change', (e) => {
      setBimVisible(e.target.checked);
    });

    document.getElementById('bim-opacity')?.addEventListener('input', (e) => {
      const value = parseInt(e.target.value) / 100;
      const display = document.getElementById('bim-opacity-value');
      if (display) display.textContent = `${e.target.value}%`;
      setBimOpacity(value);
    });

    document.getElementById('point-budget')?.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      const budget = value * 1_000_000;
      const display = document.getElementById('budget-value');
      if (display) display.textContent = `${value.toFixed(1)}M`;
      if (state.viewer) {
        state.viewer.setPointBudget(budget);
      }
    });

    document.getElementById('point-size')?.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      const display = document.getElementById('point-size-value');
      if (display) display.textContent = value.toFixed(1);
      if (state.currentPointCloud) {
        state.currentPointCloud.material.size = value;
      }
    });

    document.getElementById('edl-enabled')?.addEventListener('change', (e) => {
      if (state.viewer) {
        state.viewer.setEDLEnabled(e.target.checked);
        debugLog(`EDL ${e.target.checked ? 'enabled' : 'disabled'}`);
      }
    });

    document.getElementById('force-unlit')?.addEventListener('change', (e) => {
      setForceUnlit(e.target.checked);
    });

    document.getElementById('bim-units')?.addEventListener('change', (e) => {
      applyUnitsScale(e.target.value);
      if (state.currentPointCloud && state.currentBimRoot) {
        autoAlignBimToCloud();
      }
    });

    document.getElementById('step-size')?.addEventListener('input', (e) => {
      state.currentStep = parseInt(e.target.value);
      const step = CONFIG.nudgeSteps[state.currentStep];
      const display = document.getElementById('step-value');
      if (display) display.textContent = `${step.translate}m / ${step.rotate}°`;
    });

    document.querySelectorAll('.nudge-btn[data-axis]').forEach(btn => {
      btn.addEventListener('click', () => {
        nudgePosition(btn.dataset.axis, parseInt(btn.dataset.dir));
      });
    });

    document.querySelectorAll('.nudge-btn[data-rot]').forEach(btn => {
      btn.addEventListener('click', () => {
        nudgeRotation(btn.dataset.rot, parseInt(btn.dataset.dir));
      });
    });

    document.querySelectorAll('.nudge-btn[data-scale]').forEach(btn => {
      btn.addEventListener('click', () => {
        nudgeScale(parseInt(btn.dataset.scale));
      });
    });

    ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scale-display'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', applyManualTransform);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            applyManualTransform();
            e.target.blur();
          }
        });
      }
    });

    document.getElementById('btn-auto-align')?.addEventListener('click', () => {
      if (autoAlignBimToCloud()) {
        showStatus('BIM aligned to cloud center', 'success');
      } else {
        showStatus('Cannot auto-align: need both cloud and BIM', 'warning');
      }
    });

    document.getElementById('btn-save-alignment')?.addEventListener('click', saveAlignment);
    document.getElementById('btn-reset-transform')?.addEventListener('click', resetTransform);

    document.getElementById('btn-debug-cloud')?.addEventListener('click', runFullDiagnostics);
    document.getElementById('btn-clear-log')?.addEventListener('click', () => {
      const logEl = document.getElementById('debug-log');
      if (logEl) logEl.innerHTML = '';
    });

    window.togglePanel = function() {
      const panel = document.getElementById('custom-panel');
      const btn = document.getElementById('toggle-btn');
      if (panel && btn) {
        panel.classList.toggle('collapsed');
        btn.textContent = panel.classList.contains('collapsed') ? '+' : '−';
      }
    };

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      switch (e.key.toLowerCase()) {
        case 'r': resetCamera(); break;
        case 'f': focusBoth(); break;
        case 'c': focusCloud(); break;
        case 'b': focusBim(); break;
        case 'd': runFullDiagnostics(); break;
        case 'u': 
          const cb = document.getElementById('force-unlit');
          if (cb) { cb.checked = !cb.checked; setForceUnlit(cb.checked); }
          break;
      }
    });

    debugLog('Keyboard: R=reset, F=focus all, C=cloud, B=bim, D=diagnostics, U=unlit, H=hide, I=isolate, Shift+A=show all');
  }

  function selectFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const modelId = params.get('modelId');
    const cloudId = params.get('cloudId');

    if (cloudId) {
      const cloudSelect = document.getElementById('cloud-select');
      for (const option of cloudSelect.options) {
        if (option.value === cloudId) {
          cloudSelect.value = cloudId;
          break;
        }
      }
    }

    if (modelId) {
      const bimSelect = document.getElementById('bim-select');
      for (const option of bimSelect.options) {
        if (option.dataset.modelId === modelId) {
          bimSelect.value = option.value;
          break;
        }
      }
    }
  }

  async function init() {
    debugLog('=== Potree + BIM Viewer Initializing ===');
    showLoading('Initializing viewer...');

    if (!initPotreeViewer()) {
      hideLoading();
      return;
    }

    await Promise.all([fetchPointclouds(), fetchBimModels()]);

    populateDropdowns();
    selectFromUrl();

    setupEventHandlers();
    setupSelectionEventHandlers();
    setupBimRaycast();

    const params = new URLSearchParams(window.location.search);
    if (params.get('modelId') || params.get('cloudId')) {
      await loadSelected();
    }

    hideLoading();
    debugLog('=== Viewer Ready ===', 'success');
    debugLog('Click on BIM elements to select them (ENTREGA 2: robust selection + advanced panel)', 'info');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.ViewerState = state;
  window.runDiagnostics = runFullDiagnostics;
  window.autoAlign = autoAlignBimToCloud;
  window.setForceUnlit = setForceUnlit;

  // ENTREGA 2: Selection functions exposed for debugging
  window.clearSelection = clearSelection;
  window.selectObject = selectObject;
  window.fetchAndShowProperties = fetchAndShowProperties;
  window.hideSelectedElement = hideSelectedElement;
  window.isolateSelectedElement = isolateSelectedElement;
  window.showAllElements = showAllElements;
  window.findSelectionRoot = findSelectionRoot;
  window.togglePropsGroup = togglePropsGroup;
})();
