/*jshint jquery:true browser:true */

import { padString, toHex, toString8, toString16, toString32 } from './format.js';
import * as gbi from './gbi.js';
import * as logger from './logger.js';
import { Matrix } from './graphics/Matrix.js';
import { Tile } from './graphics/Tile.js';
import { ProjectedVertex, TriangleBuffer } from './graphics/TriangleBuffer.js';
import { Vector3 } from './graphics/Vector3.js';
import { Vector4 } from './graphics/Vector4.js';
import { convertTexels } from './graphics/convert.js';
import * as shaders from './graphics/shaders.js';
import { Texture, clampTexture } from './graphics/textures.js';

(function(n64js) {
  'use strict';
  var graphics_task_count = 0;
  var texrected = 1;

  var $textureOutput = $('#texture-content');

  var $dlistContent = $('#dlist-content');

  // Initialised in initialiseRenderer
  var $dlistOutput;
  var $dlistState;
  var $dlistScrub;

  var debugDisplayListRequested = false;
  var debugDisplayListRunning = false;
  var debugNumOps = 0;
  var debugBailAfter = -1;
  // The last task that we executed.
  var debugLastTask;
  var debugStateTimeShown = -1;

  // This is updated as we're executing, so that we know which instruction to halt on.
  var debugCurrentOp = 0;

  var textureCache;

  var gl = null;

  var frameBuffer;
  // For roms using display lists
  var frameBufferTexture3D;
  // For roms writing directly to the frame buffer
  var frameBufferTexture2D;

  // n64's display resolution
  var viWidth = 320;
  var viHeight = 240;

  // canvas dimension
  var canvasWidth = 640;
  var canvasHeight = 480;

  const kOffset_type             = 0x00; // u32
  const kOffset_flags            = 0x04; // u32
  const kOffset_ucode_boot       = 0x08; // u64*
  const kOffset_ucode_boot_size  = 0x0c; // u32
  const kOffset_ucode            = 0x10; // u64*
  const kOffset_ucode_size       = 0x14; // u32
  const kOffset_ucode_data       = 0x18; // u64*
  const kOffset_ucode_data_size  = 0x1c; // u32
  const kOffset_dram_stack       = 0x20; // u64*
  const kOffset_dram_stack_size  = 0x24; // u32
  const kOffset_output_buff      = 0x28; // u64*
  const kOffset_output_buff_size = 0x2c; // u64*
  const kOffset_data_ptr         = 0x30; // u64*
  const kOffset_data_size        = 0x34; // u32
  const kOffset_yield_data_ptr   = 0x38; // u64*
  const kOffset_yield_data_size  = 0x3c; // u32

  function updateGeometryModeFromBits(flags) {
    var gm = state.geometryMode;
    var bits = state.geometryModeBits;

    gm.zbuffer          = (bits & flags.G_ZBUFFER) ? 1 : 0;
    gm.texture          = (bits & flags.G_TEXTURE_ENABLE) ? 1 : 0;
    gm.shade            = (bits & flags.G_SHADE) ? 1 : 0;
    gm.shadeSmooth      = (bits & flags.G_SHADING_SMOOTH) ? 1 : 0;
    gm.cullFront        = (bits & flags.G_CULL_FRONT) ? 1 : 0;
    gm.cullBack         = (bits & flags.G_CULL_BACK) ? 1 : 0;
    gm.fog              = (bits & flags.G_FOG) ? 1 : 0;
    gm.lighting         = (bits & flags.G_LIGHTING) ? 1 : 0;
    gm.textureGen       = (bits & flags.G_TEXTURE_GEN) ? 1 : 0;
    gm.textureGenLinear = (bits & flags.G_TEXTURE_GEN_LINEAR) ? 1 : 0;
    gm.lod              = (bits & flags.G_LOD) ? 1 : 0;
  }

  //
  const kUCode_GBI0 = 0;
  const kUCode_GBI1 = 1;
  const kUCode_GBI2 = 2;

  const kUCode_GBI0_WR = 5;
  const kUCode_GBI0_GE = 9;

  const kUcodeStrides = [
    10, // Super Mario 64, Tetrisphere, Demos
    2, // Mario Kart, Star Fox
    2, // Zelda, and newer games
    2, // Yoshi's Story, Pokemon Puzzle League
    2, // Neon Evangelion, Kirby
    5, // Wave Racer USA
    10, // Diddy Kong Racing, Gemini, and Mickey
    2, // Last Legion, Toukon, Toukon 2
    5, // Shadows of the Empire (SOTE)
    10, // Golden Eye
    2, // Conker BFD
    10, // Perfect Dark
  ];

  // Configured:
  var config = {
    vertexStride: 10
  };

  var tmemBuffer = new ArrayBuffer(4096);

  var ram_u8;
  var ram_s32;
  var ram_dv;

  var state = {
    pc: 0,
    dlistStack: [],
    segments: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tiles: new Array(8),
    lights: new Array(8),
    numLights: 0,
    geometryModeBits: 0, // raw geometry mode, GBI specific
    geometryMode: { // unpacked geometry mode
      zbuffer: 0,
      texture: 0,
      shade: 0,
      shadeSmooth: 0,
      cullFront: 0,
      cullBack: 0,
      fog: 0,
      lighting: 0,
      textureGen: 0,
      textureGenLinear: 0,
      lod: 0
    },
    rdpOtherModeL: 0,
    rdpOtherModeH: 0,

    rdpHalf1: 0,
    rdpHalf2: 0,

    viewport: {
      scale: [160.0, 120.0],
      trans: [160.0, 120.0]
    },

    // matrix stacks
    projection: [],
    modelview: [],

    /**
     * @type {!Array<!ProjectedVertex>}
     */
    projectedVertices: new Array(64),

    scissor: {
      mode: 0,
      x0: 0,
      y0: 0,
      x1: viWidth,
      y1: viHeight
    },

    texture: {
      tile: 0,
      level: 0,
      scaleS: 1.0,
      scaleT: 1.0
    },

    combine: {
      lo: 0,
      hi: 0
    },

    fillColor: 0,
    envColor: 0,
    primColor: 0,
    blendColor: 0,
    fogColor: 0,

    primDepth: 0.0,

    colorImage: {
      format: 0,
      size: 0,
      width: 0,
      address: 0
    },

    textureImage: {
      format: 0,
      size: 0,
      width: 0,
      address: 0
    },

    depthImage: {
      address: 0
    },

    tmemData32: new Int32Array(tmemBuffer),
    tmemData: new Uint8Array(tmemBuffer),

    screenContext2d: null // canvas context
  };

  var n64ToCanvasScale = [1.0, 1.0];
  var n64ToCanvasTranslate = [0.0, 0.0];

  var canvas2dMatrix = Matrix.makeOrtho(0, canvasWidth, canvasHeight, 0, 0, 1);

  function hleHalt(msg) {
    if (!debugDisplayListRunning) {
      n64js.displayWarning(msg);

      // Ensure the CPU emulation stops immediately
      n64js.breakEmulationForDisplayListDebug();

      // Ensure the ui is visible
      showDebugDisplayListUI();

      // We're already executing a display list, so clear the Requested flag, set Running
      debugDisplayListRequested = false;
      debugDisplayListRunning = true;

      // End set up the context
      debugBailAfter = debugCurrentOp;
      debugStateTimeShown = -1;
    }
  }

  const kMaxTris = 64;
  var triangleBuffer = new TriangleBuffer(kMaxTris);

  function convertN64ToCanvas(n64_coords) {
    return [
      Math.round(Math.round(n64_coords[0]) * n64ToCanvasScale[0] + n64ToCanvasTranslate[0]),
      Math.round(Math.round(n64_coords[1]) * n64ToCanvasScale[1] + n64ToCanvasTranslate[1]),
    ];
  }

  function convertN64ToDisplay(n64_coords) {
    var canvas = convertN64ToCanvas(n64_coords);
    return [
      canvas[0] * canvas2dMatrix.elems[0] + canvas2dMatrix.elems[12],
      canvas[1] * canvas2dMatrix.elems[5] + canvas2dMatrix.elems[13],
    ];
  }

  function setCanvasViewport(w, h) {
    canvasWidth = w;
    canvasHeight = h;

    n64ToCanvasScale = [w / viWidth, h / viHeight];
    n64ToCanvasTranslate = [0, 0];

    updateViewport();
  }

  function setN64Viewport(scale, trans) {
    //logger.log('Viewport: scale=' + scale[0] + ',' + scale[1] + ' trans=' + trans[0] + ',' + trans[1] );

    if (scale[0] === state.viewport.scale[0] &&
      scale[1] === state.viewport.scale[1] &&
      trans[0] === state.viewport.trans[0] &&
      trans[1] === state.viewport.trans[1]) {
      return;
    }

    state.viewport.scale = scale;
    state.viewport.trans = trans;
    updateViewport();
  }

  function updateViewport() {
    var n64_min = [
      state.viewport.trans[0] - state.viewport.scale[0],
      state.viewport.trans[1] - state.viewport.scale[1],
    ];
    var n64_max = [
      state.viewport.trans[0] + state.viewport.scale[0],
      state.viewport.trans[1] + state.viewport.scale[1],
    ];

    var canvasMin = convertN64ToCanvas(n64_min);
    var canvasMax = convertN64ToCanvas(n64_max);

    var vp_x = canvasMin[0];
    var vp_y = canvasMin[1];
    var vp_width = canvasMax[0] - canvasMin[0];
    var vp_height = canvasMax[1] - canvasMin[1];

    canvas2dMatrix = Matrix.makeOrtho(canvasMin[0], canvasMax[0], canvasMax[1], canvasMin[1], 0, 1);

    gl.viewport(vp_x, vp_y, vp_width, vp_height);
  }

  function loadMatrix(address) {
    const recip = 1.0 / 65536.0;
    var dv = new DataView(ram_dv.buffer, address);

    var elements = new Float32Array(16);
    for (var i = 0; i < 4; ++i) {
      elements[4 * 0 + i] = (dv.getInt16(i * 8 + 0) << 16 | dv.getUint16(i * 8 + 0 + 32)) * recip;
      elements[4 * 1 + i] = (dv.getInt16(i * 8 + 2) << 16 | dv.getUint16(i * 8 + 2 + 32)) * recip;
      elements[4 * 2 + i] = (dv.getInt16(i * 8 + 4) << 16 | dv.getUint16(i * 8 + 4 + 32)) * recip;
      elements[4 * 3 + i] = (dv.getInt16(i * 8 + 6) << 16 | dv.getUint16(i * 8 + 6 + 32)) * recip;
    }

    return new Matrix(elements);
  }

  function previewViewport(address) {
    var result = '';
    result += 'scale = (' +
        ram_dv.getInt16(address + 0) / 4.0 + ', ' +
        ram_dv.getInt16(address + 2) / 4.0 + ') ';
    result += 'trans = (' +
        ram_dv.getInt16(address + 8) / 4.0 + ', ' +
        ram_dv.getInt16(address + 10) / 4.0 + ') ';
    return result;
  }

  function moveMemViewport(address) {
    var scale = new Array(2);
    var trans = new Array(2);
    scale[0] = ram_dv.getInt16(address + 0) / 4.0;
    scale[1] = ram_dv.getInt16(address + 2) / 4.0;

    trans[0] = ram_dv.getInt16(address + 8) / 4.0;
    trans[1] = ram_dv.getInt16(address + 10) / 4.0;
    setN64Viewport(scale, trans);
  }

  function previewLight(address) {
    var result = '';
    result += 'color = ' + toHex(ram_dv.getUint32(address + 0), 32) + ' ';
    var dir = Vector3.create([
      ram_dv.getInt8(address + 8),
      ram_dv.getInt8(address + 9),
      ram_dv.getInt8(address + 10)
    ]).normaliseInPlace();
    result += 'norm = (' + dir.elems[0] + ', ' + dir.elems[1] + ', ' + dir.elems[2] + ')';
    return result;
  }

  function moveMemLight(light_idx, address) {
    state.lights[light_idx].color = unpackRGBAToColor(ram_dv.getUint32(address + 0));
    state.lights[light_idx].dir = Vector3.create([
      ram_dv.getInt8(address + 8),
      ram_dv.getInt8(address + 9),
      ram_dv.getInt8(address + 10)
    ]).normaliseInPlace();
  }

  function rdpSegmentAddress(addr) {
    var segment = (addr >>> 24) & 0xf;
    return (state.segments[segment] & 0x00ffffff) + (addr & 0x00ffffff);
  }

  function makeRGBFromRGBA16(col) {
    return {
      'r': ((col >>> 11) & 0x1f) / 31.0,
      'g': ((col >>> 6) & 0x1f) / 31.0,
      'b': ((col >>> 1) & 0x1f) / 31.0,
    };
  }

  function makeRGBFromRGBA32(col) {
    return {
      'r': ((col >>> 24) & 0xff) / 255.0,
      'g': ((col >>> 16) & 0xff) / 255.0,
      'b': ((col >>> 8) & 0xff) / 255.0,
    };
  }

  function unpackRGBAToColor(col) {
    return {
      'r': ((col >>> 24) & 0xff) / 255.0,
      'g': ((col >>> 16) & 0xff) / 255.0,
      'b': ((col >>> 8) & 0xff) / 255.0,
      'a': ((col >>> 0) & 0xff) / 255.0,
    };
  }

  function makeColourText(r, g, b, a) {
    var rgb = r + ', ' + g + ', ' + b;
    var rgba = rgb + ', ' + a;

    if ((r < 128 && g < 128) ||
        (g < 128 && b < 128) ||
        (b < 128 && r < 128)) {
      return '<span style="color: white; background-color: rgb(' + rgb + ')">' + rgba + '</span>';
    }
    return '<span style="background-color: rgb(' + rgb + ')">' + rgba + '</span>';
  }

  function makeColorTextRGBA(rgba) {
    var r = (rgba >>> 24) & 0xff;
    var g = (rgba >>> 16) & 0xff;
    var b = (rgba >>> 8) & 0xff;
    var a = (rgba) & 0xff;

    return makeColourText(r, g, b, a);
  }

  function makeColorTextABGR(abgr) {
    var r = abgr & 0xff;
    var g = (abgr >>> 8) & 0xff;
    var b = (abgr >>> 16) & 0xff;
    var a = (abgr >>> 24) & 0xff;

    return makeColourText(r, g, b, a);
  }

  const M_GFXTASK = 1;
  const M_AUDTASK = 2;
  const M_VIDTASK = 3;
  const M_JPGTASK = 4;

  /**
   * @constructor
   */
  function RSPTask(task_dv) {
    this.type = task_dv.getUint32(kOffset_type);
    this.code_base = task_dv.getUint32(kOffset_ucode) & 0x1fffffff;
    this.code_size = task_dv.getUint32(kOffset_ucode_size);
    this.data_base = task_dv.getUint32(kOffset_ucode_data) & 0x1fffffff;
    this.data_size = task_dv.getUint32(kOffset_ucode_data_size);
    this.data_ptr = task_dv.getUint32(kOffset_data_ptr);
  }

  RSPTask.prototype.detectVersionString = function() {
    var r = 'R'.charCodeAt(0);
    var s = 'S'.charCodeAt(0);
    var p = 'P'.charCodeAt(0);

    for (var i = 0; i + 2 < this.data_size; ++i) {
      if (ram_u8[this.data_base + i + 0] === r &&
        ram_u8[this.data_base + i + 1] === s &&
        ram_u8[this.data_base + i + 2] === p) {
        var str = '';
        for (var j = i; j < this.data_size; ++j) {
          var c = ram_u8[this.data_base + j];
          if (c === 0)
            return str;

          str += String.fromCharCode(c);
        }
      }
    }
    return '';
  };

  RSPTask.prototype.computeMicrocodeHash = function() {
    var c = 0;
    for (var i = 0; i < this.code_size; ++i) {
      // Best hash ever!
      c = ((c * 17) + ram_u8[this.code_base + i]) >>> 0;
    }
    return c;
  };


  // task_dv is a DataView object
  n64js.rspProcessTask = function(task_dv) {
    var task = new RSPTask(task_dv);

    switch (task.type) {
      case M_GFXTASK:
        ++graphics_task_count;
        hleGraphics(task);
        n64js.interruptDP();
        break;
      case M_AUDTASK:
        //logger.log('audio task');
        break;
      case M_VIDTASK:
        logger.log('video task');
        break;
      case M_JPGTASK:
        logger.log('jpg task');
        break;

      default:
        logger.log('unknown task');
        break;
    }

    n64js.haltSP();
  };

  function unimplemented(cmd0, cmd1) {
    hleHalt('Unimplemented display list op ' + toString8(cmd0 >>> 24));
  }

  function executeUnknown(cmd0, cmd1) {
    hleHalt('Unknown display list op ' + toString8(cmd0 >>> 24));
    state.pc = 0;
  }

  function executeGBI1_SpNoop(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPNoOp();');
    }
  }

  function executeGBI1_Noop(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPNoOp();');
    }
  }

  function executeRDPLoadSync(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPLoadSync();');
    }
  }

  function executeRDPPipeSync(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPPipeSync();');
    }
  }

  function executeRDPTileSync(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPTileSync();');
    }
  }

  function executeRDPFullSync(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPFullSync();');
    }
  }

  function executeGBI1_DL(cmd0, cmd1, dis) {
    var param = ((cmd0 >>> 16) & 0xff);
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      var fn = (param === gbi.G_DL_PUSH) ? 'gsSPDisplayList' : 'gsSPBranchList';
      dis.text(fn + '(<span class="dl-branch">' + toString32(address) + '</span>);');
    }

    if (param === gbi.G_DL_PUSH) {
      state.dlistStack.push({ pc: state.pc });
    }
    state.pc = address;
  }

  function executeGBI1_EndDL(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPEndDisplayList();');
    }

    if (state.dlistStack.length > 0) {
      state.pc = state.dlistStack.pop().pc;
    } else {
      state.pc = 0;
    }
  }

  function executeGBI1_BranchZ(cmd0, cmd1) {
    var address = rdpSegmentAddress(state.rdpHalf1);
    // FIXME
    // Just branch all the time for now
    //if (vtxDepth(cmd.vtx) <= cmd.branchzvalue)
    state.pc = address;
  }

  function previewMatrix(matrix) {
    var m = matrix.elems;

    var a = [m[0], m[1], m[2], m[3]];
    var b = [m[4], m[5], m[6], m[7]];
    var c = [m[8], m[9], m[10], m[11]];
    var d = [m[12], m[13], m[14], m[15]];

    return '<div><table class="matrix-table">' +
        '<tr><td>' + a.join('</td><td>') + '</td></tr>' +
        '<tr><td>' + b.join('</td><td>') + '</td></tr>' +
        '<tr><td>' + c.join('</td><td>') + '</td></tr>' +
        '<tr><td>' + d.join('</td><td>') + '</td></tr>' +
        '</table></div>';
  }

  function executeGBI1_Matrix(cmd0, cmd1, dis) {
    var flags = (cmd0 >>> 16) & 0xff;
    var length = (cmd0 >>> 0) & 0xffff;
    var address = rdpSegmentAddress(cmd1);

    var matrix = loadMatrix(address);

    if (dis) {
      var t = '';
      t += (flags & gbi.G_MTX_PROJECTION) ? 'G_MTX_PROJECTION' : 'G_MTX_MODELVIEW';
      t += (flags & gbi.G_MTX_LOAD) ? '|G_MTX_LOAD' : '|G_MTX_MUL';
      t += (flags & gbi.G_MTX_PUSH) ? '|G_MTX_PUSH' : ''; //'|G_MTX_NOPUSH';

      dis.text('gsSPMatrix(' + toString32(address) + ', ' + t + ');');
      dis.tip(previewMatrix(matrix));
    }

    var stack = (flags & gbi.G_MTX_PROJECTION) ? state.projection : state.modelview;

    if ((flags & gbi.G_MTX_LOAD) == 0) {
      matrix = stack[stack.length - 1].multiply(matrix);
    }

    if (flags & gbi.G_MTX_PUSH) {
      stack.push(matrix);
    } else {
      stack[stack.length - 1] = matrix;
    }
  }

  function executeGBI1_PopMatrix(cmd0, cmd1, dis) {
    var flags = (cmd1 >>> 0) & 0xff;

    if (dis) {
      var t = '';
      t += (flags & gbi.G_MTX_PROJECTION) ? 'G_MTX_PROJECTION' : 'G_MTX_MODELVIEW';
      dis.text('gsSPPopMatrix(' + t + ');');
    }

    // FIXME: pop is always modelview?
    if (state.modelview.length > 0) {
      state.modelview.pop();
    }
  }

  function previewGBI1_MoveMem(type, length, address, dis) {
    var tip = '';

    for (var i = 0; i < length; ++i) {
      tip += toHex(ram_dv.getUint8(address + i), 8) + ' ';
    }
    tip += '<br>';

    switch (type) {
      case gbi.MoveMemGBI1.G_MV_VIEWPORT:
        tip += previewViewport(address);
        break;

      case gbi.MoveMemGBI1.G_MV_L0:
      case gbi.MoveMemGBI1.G_MV_L1:
      case gbi.MoveMemGBI1.G_MV_L2:
      case gbi.MoveMemGBI1.G_MV_L3:
      case gbi.MoveMemGBI1.G_MV_L4:
      case gbi.MoveMemGBI1.G_MV_L5:
      case gbi.MoveMemGBI1.G_MV_L6:
      case gbi.MoveMemGBI1.G_MV_L7:
        tip += previewLight(address);
        break;
    }

    dis.tip(tip);
  }

  function executeGBI1_MoveMem(cmd0, cmd1, dis) {
    var type = (cmd0 >>> 16) & 0xff;
    var length = (cmd0 >>> 0) & 0xffff;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      var address_str = toString32(address);

      var type_str = gbi.MoveMemGBI1.nameOf(type);
      var text = 'gsDma1p(G_MOVEMEM, ' + address_str + ', ' + length + ', ' + type_str + ');';

      switch (type) {
        case gbi.MoveMemGBI1.G_MV_VIEWPORT:
          if (length === 16)
            text = 'gsSPViewport(' + address_str + ');';
          break;
      }

      dis.text(text);
      previewGBI1_MoveMem(type, length, address, dis);
    }

    switch (type) {
      case gbi.MoveMemGBI1.G_MV_VIEWPORT:
        moveMemViewport(address);
        break;

      case gbi.MoveMemGBI1.G_MV_L0:
      case gbi.MoveMemGBI1.G_MV_L1:
      case gbi.MoveMemGBI1.G_MV_L2:
      case gbi.MoveMemGBI1.G_MV_L3:
      case gbi.MoveMemGBI1.G_MV_L4:
      case gbi.MoveMemGBI1.G_MV_L5:
      case gbi.MoveMemGBI1.G_MV_L6:
      case gbi.MoveMemGBI1.G_MV_L7:
        var light_idx = (type - gbi.MoveMemGBI1.G_MV_L0) / 2;
        moveMemLight(light_idx, address);
        break;
    }
  }

  function executeGBI1_MoveWord(cmd0, cmd1, dis) {
    var type = (cmd0) & 0xff;
    var offset = (cmd0 >>> 8) & 0xffff;
    var value = cmd1;

    if (dis) {
      var text = 'gMoveWd(' + gbi.MoveWord.nameOf(type) + ', ' + toString16(offset) + ', ' + toString32(value) + ');';

      switch (type) {
        case gbi.MoveWord.G_MW_NUMLIGHT:
          if (offset === gbi.G_MWO_NUMLIGHT) {
            var v = ((value - 0x80000000) >>> 5) - 1;
            text = 'gsSPNumLights(' + gbi.NumLights.nameOf(v) + ');';
          }
          break;
        case gbi.MoveWord.G_MW_SEGMENT:
          {
            var v = value === 0 ? '0' : toString32(value);
            text = 'gsSPSegment(' + ((offset >>> 2) & 0xf) + ', ' + v + ');';
          }
          break;
      }
      dis.text(text);
    }

    switch (type) {
      case gbi.MoveWord.G_MW_MATRIX:
        unimplemented(cmd0, cmd1);
        break;
      case gbi.MoveWord.G_MW_NUMLIGHT:
        state.numLights = ((value - 0x80000000) >>> 5) - 1;
        break;
      case gbi.MoveWord.G_MW_CLIP:
        /*unimplemented(cmd0,cmd1);*/ break;
      case gbi.MoveWord.G_MW_SEGMENT:
        state.segments[((offset >>> 2) & 0xf)] = value;
        break;
      case gbi.MoveWord.G_MW_FOG:
        /*unimplemented(cmd0,cmd1);*/ break;
      case gbi.MoveWord.G_MW_LIGHTCOL:
        unimplemented(cmd0, cmd1);
        break;
      case gbi.MoveWord.G_MW_POINTS:
        unimplemented(cmd0, cmd1);
        break;
      case gbi.MoveWord.G_MW_PERSPNORM:
        /*unimplemented(cmd0,cmd1);*/ break;
      default:
        unimplemented(cmd0, cmd1);
        break;
    }
  }

  const X_NEG = 0x01; //left
  const Y_NEG = 0x02; //bottom
  const Z_NEG = 0x04; //far
  const X_POS = 0x08; //right
  const Y_POS = 0x10; //top
  const Z_POS = 0x20; //near

  function calculateLighting(normal) {
    var num_lights = state.numLights;
    var r = state.lights[num_lights].color.r;
    var g = state.lights[num_lights].color.g;
    var b = state.lights[num_lights].color.b;

    for (var l = 0; l < num_lights; ++l) {
      var light = state.lights[l];
      var d = normal.dot(light.dir);
      if (d > 0.0) {
        r += light.color.r * d;
        g += light.color.g * d;
        b += light.color.b * d;
      }
    }

    r = Math.min(r, 1.0) * 255.0;
    g = Math.min(g, 1.0) * 255.0;
    b = Math.min(b, 1.0) * 255.0;
    let a = 255;

    return (a << 24) | (b << 16) | (g << 8) | r;
  }

  function previewVertexImpl(v0, n, dv, dis) {
    const cols = ['#', 'x', 'y', 'z', '?', 'u', 'v', 'norm', 'rgba'];

    var tip = '';
    tip += '<table class="vertex-table">';
    tip += '<tr><th>' + cols.join('</th><th>') + '</th></tr>\n';

    for (var i = 0; i < n; ++i) {
      var vtx_base = i * 16;
      var v = [
        v0 + i,
        dv.getInt16(vtx_base + 0), // x
        dv.getInt16(vtx_base + 2), // y
        dv.getInt16(vtx_base + 4), // z
        dv.getInt16(vtx_base + 6), // ?
        dv.getInt16(vtx_base + 8), // u
        dv.getInt16(vtx_base + 10), // v
        dv.getInt8(vtx_base + 12) + ',' + dv.getInt8(vtx_base + 13) + ',' + dv.getInt8(vtx_base + 14), // norm
        toString32(dv.getUint32(vtx_base + 12)), // rgba
      ];

      tip += '<tr><td>' + v.join('</td><td>') + '</td></tr>\n';
    }
    tip += '</table>';
    dis.tip(tip);
  }

  function executeVertexImpl(v0, n, address, dis) {
    var light = state.geometryMode.lighting;
    var texgen = state.geometryMode.textureGen;
    var texgenlin = state.geometryMode.textureGenLinear;

    if (address + n * 16 > 0x00800000) {
      // Wetrix causes this. Not sure if it's a cpu emulation bug which is generating bad display lists?
      //     hleHalt('Invalid address');
      return;
    }

    var dv = new DataView(ram_dv.buffer, address);

    if (dis) {
      previewVertexImpl(v0, n, dv, dis);
    }

    if (v0 + n >= 64) { // FIXME or 80 for later GBI
      hleHalt('Too many verts');
      state.pc = 0;
      return;
    }

    var mvmtx = state.modelview[state.modelview.length - 1];
    var pmtx = state.projection[state.projection.length - 1];

    var wvp = pmtx.multiply(mvmtx);

    // Texture coords are provided in 11.5 fixed point format, so divide by 32 here to normalise
    var scale_s = state.texture.scaleS / 32.0;
    var scale_t = state.texture.scaleT / 32.0;

    var xyz = new Vector3();
    var normal = new Vector3();
    var transformedNormal = new Vector3();

    for (var i = 0; i < n; ++i) {
      var vtx_base = i * 16;
      var vertex = state.projectedVertices[v0 + i];

      vertex.set = true;

      xyz.elems[0] = dv.getInt16(vtx_base + 0);
      xyz.elems[1] = dv.getInt16(vtx_base + 2);
      xyz.elems[2] = dv.getInt16(vtx_base + 4);
      //var w = dv.getInt16(vtx_base + 6);
      var u = dv.getInt16(vtx_base + 8);
      var v = dv.getInt16(vtx_base + 10);

      var projected = vertex.pos;
      wvp.transformPoint(xyz, projected);

      //hleHalt(x + ',' + y + ',' + z + '-&gt;' + projected.elems[0] + ',' + projected.elems[1] + ',' + projected.elems[2]);

      // var clip_flags = 0;
      //      if (projected[0] < -projected[3]) clip_flags |= X_POS;
      // else if (projected[0] >  projected[3]) clip_flags |= X_NEG;

      //      if (projected[1] < -projected[3]) clip_flags |= Y_POS;
      // else if (projected[1] >  projected[3]) clip_flags |= Y_NEG;

      //      if (projected[2] < -projected[3]) clip_flags |= Z_POS;
      // else if (projected[2] >  projected[3]) clip_flags |= Z_NEG;
      // state.projectedVertices.clipFlags = clip_flags;

      if (light) {
        normal.elems[0] = dv.getInt8(vtx_base + 12);
        normal.elems[1] = dv.getInt8(vtx_base + 13);
        normal.elems[2] = dv.getInt8(vtx_base + 14);

        // calculate transformed normal
        mvmtx.transformNormal(normal, transformedNormal);
        transformedNormal.normaliseInPlace();

        vertex.color = calculateLighting(transformedNormal);

        if (texgen) {
          // retransform using wvp
          // wvp.transformNormal(normal, transformedNormal);
          // transformedNormal.normaliseInPlace();

          if (texgenlin) {
            vertex.u = 0.5 * (1.0 + transformedNormal.elems[0]);
            vertex.v = 0.5 * (1.0 + transformedNormal.elems[1]); // 1-y?
          } else {
            vertex.u = Math.acos(transformedNormal.elems[0]) / 3.141;
            vertex.v = Math.acos(transformedNormal.elems[1]) / 3.141;
          }
        } else {
          vertex.u = u * scale_s;
          vertex.v = v * scale_t;
        }
      } else {
        vertex.u = u * scale_s;
        vertex.v = v * scale_t;

        var r = dv.getUint8(vtx_base + 12);
        var g = dv.getUint8(vtx_base + 13);
        var b = dv.getUint8(vtx_base + 14);
        var a = dv.getUint8(vtx_base + 15);

        vertex.color = (a << 24) | (b << 16) | (g << 8) | r;
      }

      //var flag = dv.getUint16(vtx_base + 6);
      //var tu = dv.getInt16(vtx_base + 8);
      //var tv = dv.getInt16(vtx_base + 10);
      //var rgba = dv.getInt16(vtx_base + 12);    // nx/ny/nz/a
    }
  }

  function executeGBI1_Sprite2DBase(cmd0, cmd1) { unimplemented(cmd0, cmd1); }

  function executeGBI1_RDPHalf_Cont(cmd0, cmd1) { unimplemented(cmd0, cmd1); }

  function executeGBI1_RDPHalf_2(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsImmp1(G_RDPHALF_2, ' + toString32(cmd1) + ');');
    }
    state.rdpHalf2 = cmd1;
  }

  function executeGBI1_RDPHalf_1(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsImmp1(G_RDPHALF_1, ' + toString32(cmd1) + ');');
    }
    state.rdpHalf1 = cmd1;
  }

  function executeGBI1_ClrGeometryMode(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPClearGeometryMode(' +
        gbi.getGeometryModeFlagsText(gbi.GeometryModeGBI1, cmd1) + ');');
    }
    state.geometryModeBits &= ~cmd1;
    updateGeometryModeFromBits(gbi.GeometryModeGBI1);
  }

  function executeGBI1_SetGeometryMode(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPSetGeometryMode(' +
        gbi.getGeometryModeFlagsText(gbi.GeometryModeGBI1, cmd1) + ');');
    }
    state.geometryModeBits |= cmd1;
    updateGeometryModeFromBits(gbi.GeometryModeGBI1);
  }

  function disassembleSetOtherModeL(dis, len, shift, data) {
    var dataStr = toString32(data);
    var shiftStr = gbi.getOtherModeLShiftCountName(shift);
    var text = 'gsSPSetOtherMode(G_SETOTHERMODE_L, ' + shiftStr + ', ' + len + ', ' + dataStr +
      ');';

    // Override generic text with specific functions if known
    switch (shift) {
      case gbi.G_MDSFT_ALPHACOMPARE:
        if (len === 2) {
          text = 'gsDPSetAlphaCompare(' + gbi.AlphaCompare.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_ZSRCSEL:
        if (len === 1) {
          text = 'gsDPSetDepthSource(' + gbi.DepthSource.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_RENDERMODE:
        if (len === 29) {
          text = 'gsDPSetRenderMode(' + gbi.getRenderModeText(data) + ');';
        }
        break;
        //case gbi.G_MDSFT_BLENDER:     break; // set with G_MDSFT_RENDERMODE
    }
    dis.text(text);
  }

  function disassembleSetOtherModeH(dis, len, shift, data) {
    var shiftStr = gbi.getOtherModeHShiftCountName(shift);
    var dataStr = toString32(data);
    var text = 'gsSPSetOtherMode(G_SETOTHERMODE_H, ' + shiftStr + ', ' + len + ', ' + dataStr + ');';

    // Override generic text with specific functions if known
    switch (shift) {
      case gbi.G_MDSFT_BLENDMASK:
        break;
      case gbi.G_MDSFT_ALPHADITHER:
        if (len === 2) {
          text = 'gsDPSetAlphaDither(' + gbi.AlphaDither.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_RGBDITHER:
        if (len === 2) {
          text = 'gsDPSetColorDither(' + gbi.ColorDither.nameOf(data) + ');';
        }
        break; // NB HW2?
      case gbi.G_MDSFT_COMBKEY:
        if (len === 1) {
          text = 'gsDPSetCombineKey(' + gbi.CombineKey.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTCONV:
        if (len === 3) {
          text = 'gsDPSetTextureConvert(' + gbi.TextureConvert.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTFILT:
        if (len === 2) {
          text = 'gsDPSetTextureFilter(' + gbi.TextureFilter.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTLOD:
        if (len === 1) {
          text = 'gsDPSetTextureLOD(' + gbi.TextureLOD.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTLUT:
        if (len === 2) {
          text = 'gsDPSetTextureLUT(' + gbi.TextureLUT.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTDETAIL:
        if (len === 2) {
          text = 'gsDPSetTextureDetail(' + gbi.TextureDetail.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_TEXTPERSP:
        if (len === 1) {
          text = 'gsDPSetTexturePersp(' + gbi.TexturePerspective.nameOf(data) + ');';
        }
        break;
      case gbi.G_MDSFT_CYCLETYPE:
        if (len === 2) {
          text = 'gsDPSetCycleType(' + gbi.CycleType.nameOf(data) + ');';
        }
        break;
        //case gbi.G_MDSFT_COLORDITHER: if (len === 1) text = 'gsDPSetColorDither(' + dataStr + ');'; break;  // NB HW1?
      case gbi.G_MDSFT_PIPELINE:
        if (len === 1) {
          text = 'gsDPPipelineMode(' + gbi.PipelineMode.nameOf(data) + ');';
        }
        break;
    }
    dis.text(text);
  }

  function executeGBI1_SetOtherModeL(cmd0, cmd1, dis) {
    var shift = (cmd0 >>> 8) & 0xff;
    var len = (cmd0 >>> 0) & 0xff;
    var data = cmd1;
    var mask = ((1 << len) - 1) << shift;

    if (dis) {
      disassembleSetOtherModeL(dis, len, shift, data);
    }

    state.rdpOtherModeL = (state.rdpOtherModeL & ~mask) | data;
  }

  function executeGBI1_SetOtherModeH(cmd0, cmd1, dis) {
    var shift = (cmd0 >>> 8) & 0xff;
    var len = (cmd0 >>> 0) & 0xff;
    var data = cmd1;
    var mask = ((1 << len) - 1) << shift;

    if (dis) {
      disassembleSetOtherModeH(dis, len, shift, data);
    }

    state.rdpOtherModeH = (state.rdpOtherModeH & ~mask) | data;
  }

  function calcTextureScale(v) {
    if (v === 0 || v === 0xffff) {
      return 1.0;
    }
    return v / 65536.0;
  }

  function executeGBI1_Texture(cmd0, cmd1, dis) {
    var xparam = (cmd0 >>> 16) & 0xff;
    var level = (cmd0 >>> 11) & 0x3;
    var tileIdx = (cmd0 >>> 8) & 0x7;
    var on = (cmd0 >>> 0) & 0xff;
    var s = calcTextureScale(((cmd1 >>> 16) & 0xffff));
    var t = calcTextureScale(((cmd1 >>> 0) & 0xffff));

    if (dis) {
      var s_text = s.toString();
      var t_text = t.toString();
      var tile_text = gbi.getTileText(tileIdx);

      if (xparam !== 0) {
        dis.text('gsSPTextureL(' + s_text + ', ' + t_text + ', ' + level + ', ' + xparam + ', ' +
          tile_text + ', ' + on + ');');
      } else {
        dis.text('gsSPTexture(' + s_text + ', ' + t_text + ', ' + level + ', ' + tile_text + ', ' +
          on + ');');
      }
    }

    state.texture.level = level;
    state.texture.tile = tileIdx;
    state.texture.scaleS = s;
    state.texture.scaleT = t;

    if (on) {
      state.geometryModeBits |= gbi.GeometryModeGBI1.G_TEXTURE_ENABLE;
    } else {
      state.geometryModeBits &= ~gbi.GeometryModeGBI1.G_TEXTURE_ENABLE;
    }
    updateGeometryModeFromBits(gbi.GeometryModeGBI1);
  }

  function executeGBI1_CullDL(cmd0, cmd1) {
    // FIXME: culldl
  }

  function executeGBI1_Tri1(cmd0, cmd1, dis) {
    var kTri1 = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var flag = (cmd1 >>> 24) & 0xff;
      var v0idx = ((cmd1 >>> 16) & 0xff) / stride;
      var v1idx = ((cmd1 >>> 8) & 0xff) / stride;
      var v2idx = ((cmd1 >>> 0) & 0xff) / stride;

      if (dis) {
        dis.text('gsSP1Triangle(' + v0idx + ', ' + v1idx + ', ' + v2idx + ', ' + flag + ');');
      }

      triangleBuffer.pushTri(verts[v0idx], verts[v1idx], verts[v2idx], triIdx);
      triIdx++;

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;

      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kTri1 && triIdx < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeTri4_GBI0(cmd0, cmd1, dis) {
    var kTri4 = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var v09_idx = ((cmd0 >>> 12) & 0xf);
      var v06_idx = ((cmd0 >>> 8) & 0xf);
      var v03_idx = ((cmd0 >>> 4) & 0xf);
      var v00_idx = ((cmd0 >>> 0) & 0xf);
      var v11_idx = ((cmd1 >>> 28) & 0xf);
      var v10_idx = ((cmd1 >>> 24) & 0xf);
      var v08_idx = ((cmd1 >>> 20) & 0xf);
      var v07_idx = ((cmd1 >>> 16) & 0xf);
      var v05_idx = ((cmd1 >>> 12) & 0xf);
      var v04_idx = ((cmd1 >>> 8) & 0xf);
      var v02_idx = ((cmd1 >>> 4) & 0xf);
      var v01_idx = ((cmd1 >>> 0) & 0xf);

      if (dis) {
        dis.text('gsSP1Triangle4(' +
          v00_idx + ',' + v01_idx + ',' + v02_idx + ', ' +
          v03_idx + ',' + v04_idx + ',' + v05_idx + ', ' +
          v06_idx + ',' + v07_idx + ',' + v08_idx + ', ' +
          v09_idx + ',' + v10_idx + ',' + v11_idx + ');');
      }

      if (v00_idx !== v01_idx) {
        triangleBuffer.pushTri(verts[v00_idx], verts[v01_idx], verts[v02_idx], triIdx);
        triIdx++;
      }
      if (v03_idx !== v04_idx) {
        triangleBuffer.pushTri(verts[v03_idx], verts[v04_idx], verts[v05_idx], triIdx);
        triIdx++;
      }
      if (v06_idx !== v07_idx) {
        triangleBuffer.pushTri(verts[v06_idx], verts[v07_idx], verts[v08_idx], triIdx);
        triIdx++;
      }
      if (v09_idx !== v10_idx) {
        triangleBuffer.pushTri(verts[v09_idx], verts[v10_idx], verts[v11_idx], triIdx);
        triIdx++;
      }

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;
      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kTri4 && triIdx < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeGBI1_Tri2(cmd0, cmd1, dis) {
    var kTri2 = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var v0idx = ((cmd0 >>> 16) & 0xff) / stride;
      var v1idx = ((cmd0 >>> 8) & 0xff) / stride;
      var v2idx = ((cmd0 >>> 0) & 0xff) / stride;
      var v3idx = ((cmd1 >>> 16) & 0xff) / stride;
      var v4idx = ((cmd1 >>> 8) & 0xff) / stride;
      var v5idx = ((cmd1 >>> 0) & 0xff) / stride;

      if (dis) {
        dis.text('gsSP1Triangle2(' + v0idx + ',' + v1idx + ',' + v2idx + ', ' +
          v3idx + ',' + v4idx + ',' + v5idx + ');');
      }

      triangleBuffer.pushTri(verts[v0idx], verts[v1idx], verts[v2idx], triIdx);
      triIdx++;
      triangleBuffer.pushTri(verts[v3idx], verts[v4idx], verts[v5idx], triIdx);
      triIdx++;

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;
      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kTri2 && triIdx < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeGBI1_Line3D(cmd0, cmd1, dis) {
    var kLine3D = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var v3idx = ((cmd1 >>> 24) & 0xff) / stride;
      var v0idx = ((cmd1 >>> 16) & 0xff) / stride;
      var v1idx = ((cmd1 >>> 8) & 0xff) / stride;
      var v2idx = ((cmd1 >>> 0) & 0xff) / stride;

      if (dis) {
        dis.text('gsSPLine3D(' + v0idx + ', ' + v1idx + ', ' + v2idx + ', ' + v3idx + ');');
      }

      triangleBuffer.pushTri(verts[v0idx], verts[v1idx], verts[v2idx], triIdx);
      triIdx++;
      triangleBuffer.pushTri(verts[v2idx], verts[v3idx], verts[v0idx], triIdx);
      triIdx++;

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;
      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kLine3D && triIdx + 1 < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeSetKeyGB(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPSetKeyGB(???);');
    }
  }

  function executeSetKeyR(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPSetKeyR(???);');
    }
  }

  function executeSetConvert(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPSetConvert(???);');
    }
  }

  function executeSetScissor(cmd0, cmd1, dis) {
    var x0 = ((cmd0 >>> 12) & 0xfff) / 4.0;
    var y0 = ((cmd0 >>> 0) & 0xfff) / 4.0;
    var x1 = ((cmd1 >>> 12) & 0xfff) / 4.0;
    var y1 = ((cmd1 >>> 0) & 0xfff) / 4.0;
    var mode = (cmd1 >>> 24) & 0x2;

    if (dis) {
      dis.text('gsDPSetScissor(' + gbi.ScissorMode.nameOf(mode) + ', ' + x0 + ', ' + y0 +
        ', ' + x1 + ', ' + y1 + ');');
    }

    state.scissor.x0 = x0;
    state.scissor.y0 = y0;
    state.scissor.x1 = x1;
    state.scissor.y1 = y1;
    state.scissor.mode = mode;

    // FIXME: actually set this
  }

  function executeSetPrimDepth(cmd0, cmd1, dis) {
    var z = (cmd1 >>> 16) & 0xffff;
    var dz = (cmd1) & 0xffff;
    if (dis) {
      dis.text('gsDPSetPrimDepth(' + z + ',' + dz + ');');
    }

    // FIXME
  }

  function executeSetRDPOtherMode(cmd0, cmd1) { unimplemented(cmd0, cmd1); }

  function calcTextureAddress(uls, ult, address, width, size) {
    return state.textureImage.address +
        (ult * ((state.textureImage.width << size) >>> 1)) +
        ((uls << size) >>> 1);
  }

  // tmem/ram should be Int32Array
  function copyLineQwords(tmem, tmem_offset, ram, ram_offset, qwords) {
    for (let i = 0; i < qwords; ++i) {
      tmem[tmem_offset + 0] = ram[ram_offset + 0];
      tmem[tmem_offset + 1] = ram[ram_offset + 1];
      tmem_offset += 2;
      ram_offset += 2;
    }
  }
  // tmem/ram should be Int32Array
  function copyLineQwordsSwap(tmem, tmem_offset, ram, ram_offset, qwords) {
    if (tmem_offset & 1) { hleHalt("oops, tmem isn't qword aligned"); }

    for (let i = 0; i < qwords; ++i) {
      tmem[(tmem_offset + 0) ^ 0x1] = ram[ram_offset + 0];
      tmem[(tmem_offset + 1) ^ 0x1] = ram[ram_offset + 1];
      tmem_offset += 2;
      ram_offset += 2;
    }
  }

  function invalidateTileHashes() {
    for (let i = 0; i < 8; ++i) {
      state.tiles[i].hash = 0;
    }
  }

  function executeLoadBlock(cmd0, cmd1, dis) {
    var uls = (cmd0 >>> 12) & 0xfff;
    var ult = (cmd0 >>> 0) & 0xfff;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var lrs = (cmd1 >>> 12) & 0xfff;
    var dxt = (cmd1 >>> 0) & 0xfff;

    if (dis) {
      var tt = gbi.getTileText(tileIdx);
      dis.text('gsDPLoadBlock(' + tt + ', ' + uls + ', ' + ult + ', ' + lrs + ', ' + dxt + ');');
    }

    // Docs reckon these are ignored for all loadBlocks
    if (uls !== 0) { hleHalt('Unexpected non-zero uls in load block'); }
    if (ult !== 0) { hleHalt('Unexpected non-zero ult in load block'); }

    var tile = state.tiles[tileIdx];
    var ram_address = calcTextureAddress(uls, ult,
                                         state.textureImage.address,
                                         state.textureImage.width,
                                         state.textureImage.size);

    var bytes = ((lrs + 1) << state.textureImage.size) >>> 1;
    var qwords = (bytes + 7) >>> 3;

    var tmem_data = state.tmemData32;

    // Offsets in 32 bit words.
    var ram_offset = ram_address >>> 2;
    var tmem_offset = (tile.tmem << 3) >>> 2;

    // Slight fast path for dxt == 0
    if (dxt === 0) {
      copyLineQwords(tmem_data, tmem_offset, ram_s32, ram_offset, qwords);
    } else {
      var qwords_per_line = Math.ceil(2048 / dxt);
      var row_swizzle = 0;
      for (let i = 0; i < qwords;) {
        var qwords_to_copy = Math.min(qwords - i, qwords_per_line);

        if (row_swizzle) {
          copyLineQwordsSwap(tmem_data, tmem_offset, ram_s32, ram_offset, qwords_to_copy);
        } else {
          copyLineQwords(tmem_data, tmem_offset, ram_s32, ram_offset, qwords_to_copy);
        }

        i += qwords_to_copy;

        // 2 words per quadword copied
        tmem_offset += qwords_to_copy * 2;
        ram_offset += qwords_to_copy * 2;

        // All odd lines are swapped
        row_swizzle ^= 0x1;
      }
    }
    invalidateTileHashes();
  }

  function copyLine(tmem, tmem_offset, ram, ram_offset, bytes) {
    for (let x = 0; x < bytes; ++x) {
      tmem[tmem_offset + x] = ram[ram_offset + x];
    }
  }

  function copyLineSwap(tmem, tmem_offset, ram, ram_offset, bytes) {
    for (let x = 0; x < bytes; ++x) {
      tmem[(tmem_offset + x) ^ 0x4] = ram[(ram_offset + x)];
    }
  }

  function executeLoadTile(cmd0, cmd1, dis) {
    var uls = (cmd0 >>> 12) & 0xfff;
    var ult = (cmd0 >>> 0) & 0xfff;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var lrs = (cmd1 >>> 12) & 0xfff;
    var lrt = (cmd1 >>> 0) & 0xfff;

    if (dis) {
      var tt = gbi.getTileText(tileIdx);
      dis.text('gsDPLoadTile(' + tt + ', ' +
          (uls / 4) + ', ' + (ult / 4) + ', ' +
          (lrs / 4) + ', ' + (lrt / 4) + '); ' +
          '// ' +
          '(' + (uls / 4) + ',' + (ult / 4) + '), (' +
          ((lrs / 4) + 1) + ',' + ((lrt / 4) + 1) + ')');
    }

    var tile = state.tiles[tileIdx];
    var ram_address = calcTextureAddress(uls >>> 2, ult >>> 2,
                                         state.textureImage.address,
                                         state.textureImage.width,
                                         state.textureImage.size);
    var pitch = (state.textureImage.width << state.textureImage.size) >>> 1;

    var h = ((lrt - ult) >>> 2) + 1;
    var w = ((lrs - uls) >>> 2) + 1;
    var bytes = ((h * w) << state.textureImage.size) >>> 1;
    var qwords = (bytes + 7) >>> 3;

    if (qwords > 512)
      qwords = 512;

    // loadTile pads rows to 8 bytes.
    var tmem_data = state.tmemData;
    var tmem_offset = tile.tmem << 3;

    var ram_offset = ram_address;

    var bytes_per_line = (w << state.textureImage.size) >>> 1;
    var bytes_per_tmem_line = tile.line << 3;

    if (state.textureImage.size == gbi.ImageSize.G_IM_SIZ_32b) {
      bytes_per_tmem_line = bytes_per_tmem_line * 2;
    }
    // if (bytes_per_tmem_line < roundUpMultiple8(bytes_per_line)) {
    //   hleHalt('line is shorter than texel count');
    // }

    var x, y;
    for (y = 0; y < h; ++y) {
      if (y & 1) {
        copyLineSwap(tmem_data, tmem_offset, ram_u8, ram_offset, bytes_per_tmem_line);
      } else {
        copyLine(tmem_data, tmem_offset, ram_u8, ram_offset, bytes_per_tmem_line);
      }

      // Pad lines to a quadword
      for (x = bytes_per_line; x < bytes_per_tmem_line; ++x) {
        tmem_data[tmem_offset + x] = 0;
      }

      tmem_offset += bytes_per_tmem_line;
      ram_offset += pitch;
    }

    invalidateTileHashes();
  }

  function executeLoadTLut(cmd0, cmd1, dis) {
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var count = (cmd1 >>> 14) & 0x3ff;

    // NB, in Daedalus, we interpret this similarly to a loadtile command,
    // but in other places it's defined as a simple count parameter.
    var uls = (cmd0 >>> 12) & 0xfff;
    var ult = (cmd0 >>> 0) & 0xfff;
    var lrs = (cmd1 >>> 12) & 0xfff;
    var lrt = (cmd1 >>> 0) & 0xfff;

    if (dis) {
      var tt = gbi.getTileText(tileIdx);
      dis.text('gsDPLoadTLUTCmd(' + tt + ', ' + count + '); //' +
        uls + ', ' + ult + ', ' + lrs + ', ' + lrt);
    }

    // Tlut fmt is sometimes wrong (in 007) and is set after tlut load, but
    // before tile load. Format is always 16bpp - RGBA16 or IA16:
    // var address = calcTextureAddress(uls >>> 2, ult >>> 2,
    //                                  state.textureImage.address,
    //                                  åstate.textureImage.width,
    //                                  åstate.textureImage.size);
    var ram_offset = calcTextureAddress(uls >>> 2, ult >>> 2,
                                        state.textureImage.address,
                                        state.textureImage.width,
                                        gbi.ImageSize.G_IM_SIZ_16b);
    var pitch = (state.textureImage.width << gbi.ImageSize.G_IM_SIZ_16b) >>> 1;

    var tile = state.tiles[tileIdx];
    var texels = ((lrs - uls) >>> 2) + 1;
    var bytes = texels * 2;

    var tmem_offset = tile.tmem << 3;

    copyLine(state.tmemData, tmem_offset, ram_u8, ram_offset, bytes);

    invalidateTileHashes();
  }

  function executeSetTile(cmd0, cmd1, dis) {
    var format = (cmd0 >>> 21) & 0x7;
    var size = (cmd0 >>> 19) & 0x3;
    //var pad0 = (cmd0 >>> 18) & 0x1;
    var line = (cmd0 >>> 9) & 0x1ff;
    var tmem = (cmd0 >>> 0) & 0x1ff;

    //var pad1 = (cmd1 >>> 27) & 0x1f;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var palette = (cmd1 >>> 20) & 0xf;

    var cm_t = (cmd1 >>> 18) & 0x3;
    var mask_t = (cmd1 >>> 14) & 0xf;
    var shift_t = (cmd1 >>> 10) & 0xf;

    var cm_s = (cmd1 >>> 8) & 0x3;
    var mask_s = (cmd1 >>> 4) & 0xf;
    var shift_s = (cmd1 >>> 0) & 0xf;

    if (dis) {
      var cm_s_text = gbi.getClampMirrorWrapText(cm_s);
      var cm_t_text = gbi.getClampMirrorWrapText(cm_t);

      dis.text('gsDPSetTile(' +
        gbi.ImageFormat.nameOf(format) + ', ' +
        gbi.ImageSize.nameOf(size) + ', ' +
        line + ', ' + tmem + ', ' + gbi.getTileText(tileIdx) + ', ' +
        palette + ', ' +
        cm_t_text + ', ' + mask_t + ', ' + shift_t + ', ' +
        cm_s_text + ', ' + mask_s + ', ' + shift_s + ');');
    }

    var tile = state.tiles[tileIdx];
    tile.format = format;
    tile.size = size;
    tile.line = line;
    tile.tmem = tmem;
    tile.palette = palette;
    tile.cm_t = cm_t;
    tile.mask_t = mask_t;
    tile.shift_t = shift_t;
    tile.cm_s = cm_s;
    tile.mask_s = mask_s;
    tile.shift_s = shift_s;
    tile.hash = 0;
  }

  function executeSetTileSize(cmd0, cmd1, dis) {
    var uls = (cmd0 >>> 12) & 0xfff;
    var ult = (cmd0 >>> 0) & 0xfff;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var lrs = (cmd1 >>> 12) & 0xfff;
    var lrt = (cmd1 >>> 0) & 0xfff;

    if (dis) {
      var tt = gbi.getTileText(tileIdx);
      dis.text('gsDPSetTileSize(' + tt + ', ' +
        uls + ', ' + ult + ', ' +
        lrs + ', ' + lrt + '); // ' +
        '(' + (uls / 4) + ',' + (ult / 4) + '), ' +
        '(' + ((lrs / 4) + 1) + ',' + ((lrt / 4) + 1) + ')');
    }

    var tile = state.tiles[tileIdx];
    tile.uls = uls;
    tile.ult = ult;
    tile.lrs = lrs;
    tile.lrt = lrt;
    tile.hash = 0;
  }

  function executeFillRect(cmd0, cmd1, dis) {
    // NB: fraction is ignored
    var x0 = ((cmd1 >>> 12) & 0xfff) >>> 2;
    var y0 = ((cmd1 >>> 0) & 0xfff) >>> 2;
    var x1 = ((cmd0 >>> 12) & 0xfff) >>> 2;
    var y1 = ((cmd0 >>> 0) & 0xfff) >>> 2;

    if (dis) {
      dis.text('gsDPFillRectangle(' + x0 + ', ' + y0 + ', ' + x1 + ', ' + y1 + ');');
    }

    if (state.depthImage.address == state.colorImage.address) {
      gl.clearDepth(1.0);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      return;
    }

    var cycle_type = getCycleType();

    var color = { r: 0, g: 0, b: 0, a: 0 };

    if (cycle_type === gbi.CycleType.G_CYC_FILL) {
      x1 += 1;
      y1 += 1;

      if (state.colorImage.size === gbi.ImageSize.G_IM_SIZ_16b) {
        color = makeRGBFromRGBA16(state.fillColor & 0xffff);
      } else {
        color = makeRGBFromRGBA32(state.fillColor);
      }

      // Clear whole screen in one?
      if (viWidth === (x1 - x0) && viHeight === (y1 - y0)) {
        gl.clearColor(color.r, color.g, color.b, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
    } else if (cycle_type === gbi.CycleType.G_CYC_COPY) {
      x1 += 1;
      y1 += 1;
    }
    //color.r = Math.random();
    color.a = 1.0;
    fillRect(x0, y0, x1, y1, color);
  }

  function executeTexRect(cmd0, cmd1, dis) {
    if (!texrected) {
      n64js.emitRunningTime('texrect');
      texrected = true;
    }

    // The following 2 commands contain additional info
    // TODO: check op code matches what we expect?
    var pc = state.pc;
    var cmd2 = ram_dv.getUint32(state.pc + 4);
    var cmd3 = ram_dv.getUint32(state.pc + 12);
    state.pc += 16;

    var xh = ((cmd0 >>> 12) & 0xfff) / 4.0;
    var yh = ((cmd0 >>> 0) & 0xfff) / 4.0;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var xl = ((cmd1 >>> 12) & 0xfff) / 4.0;
    var yl = ((cmd1 >>> 0) & 0xfff) / 4.0;
    var s0 = ((cmd2 >>> 16) & 0xffff) / 32.0;
    var t0 = ((cmd2 >>> 0) & 0xffff) / 32.0;
    // NB - signed value
    var dsdx = ((cmd3 | 0) >> 16) / 1024.0;
    var dtdy = ((cmd3 << 16) >> 16) / 1024.0;

    if (dis) {
      var tt = gbi.getTileText(tileIdx);
      dis.text('gsSPTextureRectangle(' +
        xl + ',' + yl + ',' + xh + ',' + yh + ',' +
        tt + ',' + s0 + ',' + t0 + ',' + dsdx + ',' + dtdy + ');');
    }

    var cycle_type = getCycleType();

    // In copy mode 4 pixels are copied at once.
    if (cycle_type === gbi.CycleType.G_CYC_COPY) {
      dsdx *= 0.25;
    }

    // In Fill/Copy mode the coordinates are inclusive (i.e. add 1.0f to the w/h)
    if (cycle_type === gbi.CycleType.G_CYC_COPY ||
      cycle_type === gbi.CycleType.G_CYC_FILL) {
      xh += 1.0;
      yh += 1.0;
    }

    var s1 = s0 + dsdx * (xh - xl);
    var t1 = t0 + dtdy * (yh - yl);

    texRect(tileIdx, xl, yl, xh, yh, s0, t0, s1, t1, false);
  }

  function executeTexRectFlip(cmd0, cmd1) {
    // The following 2 commands contain additional info
    // TODO: check op code matches what we expect?
    var pc = state.pc;
    var cmd2 = ram_dv.getUint32(state.pc + 4);
    var cmd3 = ram_dv.getUint32(state.pc + 12);
    state.pc += 16;

    var xh = ((cmd0 >>> 12) & 0xfff) / 4.0;
    var yh = ((cmd0 >>> 0) & 0xfff) / 4.0;
    var tileIdx = (cmd1 >>> 24) & 0x7;
    var xl = ((cmd1 >>> 12) & 0xfff) / 4.0;
    var yl = ((cmd1 >>> 0) & 0xfff) / 4.0;
    var s0 = ((cmd2 >>> 16) & 0xffff) / 32.0;
    var t0 = ((cmd2 >>> 0) & 0xffff) / 32.0;
    // NB - signed value
    var dsdx = ((cmd3 | 0) >> 16) / 1024.0;
    var dtdy = ((cmd3 << 16) >> 16) / 1024.0;

    var cycle_type = getCycleType();

    // In copy mode 4 pixels are copied at once.
    if (cycle_type === gbi.CycleType.G_CYC_COPY) {
      dsdx *= 0.25;
    }

    // In Fill/Copy mode the coordinates are inclusive (i.e. add 1.0f to the w/h)
    if (cycle_type === gbi.CycleType.G_CYC_COPY ||
      cycle_type === gbi.CycleType.G_CYC_FILL) {
      xh += 1.0;
      yh += 1.0;
    }

    // NB x/y are flipped
    var s1 = s0 + dsdx * (yh - yl);
    var t1 = t0 + dtdy * (xh - xl);

    texRect(tileIdx, xl, yl, xh, yh, s0, t0, s1, t1, true);
  }


  function executeSetFillColor(cmd0, cmd1, dis) {
    if (dis) {
      // Can be 16 or 32 bit
      dis.text('gsDPSetFillColor(' + makeColorTextRGBA(cmd1) + ');');
    }
    state.fillColor = cmd1;
  }

  function executeSetFogColor(cmd0, cmd1, dis) {
    if (dis) {
      var r = (cmd1 >>> 24) & 0xff;
      var g = (cmd1 >>> 16) & 0xff;
      var b = (cmd1 >>> 8) & 0xff;
      var a = (cmd1 >>> 0) & 0xff;

      dis.text('gsDPSetFogColor(' + makeColorTextRGBA(cmd1) + ');');
    }
    state.fogColor = cmd1;
  }

  function executeSetBlendColor(cmd0, cmd1, dis) {
    if (dis) {
      var r = (cmd1 >>> 24) & 0xff;
      var g = (cmd1 >>> 16) & 0xff;
      var b = (cmd1 >>> 8) & 0xff;
      var a = (cmd1 >>> 0) & 0xff;

      dis.text('gsDPSetBlendColor(' + makeColorTextRGBA(cmd1) + ');');
    }
    state.blendColor = cmd1;
  }

  function executeSetPrimColor(cmd0, cmd1, dis) {
    if (dis) {
      var m = (cmd0 >>> 8) & 0xff;
      var l = (cmd0 >>> 0) & 0xff;
      var r = (cmd1 >>> 24) & 0xff;
      var g = (cmd1 >>> 16) & 0xff;
      var b = (cmd1 >>> 8) & 0xff;
      var a = (cmd1 >>> 0) & 0xff;

      dis.text('gsDPSetPrimColor(' + m + ', ' + l + ', ' + makeColorTextRGBA(cmd1) + ');');
    }
    // minlevel, primlevel ignored!
    state.primColor = cmd1;
  }

  function executeSetEnvColor(cmd0, cmd1, dis) {
    if (dis) {
      var r = (cmd1 >>> 24) & 0xff;
      var g = (cmd1 >>> 16) & 0xff;
      var b = (cmd1 >>> 8) & 0xff;
      var a = (cmd1 >>> 0) & 0xff;

      dis.text('gsDPSetEnvColor(' + makeColorTextRGBA(cmd1) + ');');
    }
    state.envColor = cmd1;
  }

  function executeSetCombine(cmd0, cmd1, dis) {

    if (dis) {
      var mux0 = cmd0 & 0x00ffffff;
      var mux1 = cmd1;
      var decoded = shaders.getCombinerText(mux0, mux1);

      dis.text('gsDPSetCombine(' + toString32(mux0) + ', ' + toString32(mux1) + ');' + '\n' +
        decoded);
    }

    state.combine.hi = cmd0 & 0x00ffffff;
    state.combine.lo = cmd1;
  }

  function executeSetTImg(cmd0, cmd1, dis) {
    var format = (cmd0 >>> 21) & 0x7;
    var size = (cmd0 >>> 19) & 0x3;
    var width = ((cmd0 >>> 0) & 0xfff) + 1;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsDPSetTextureImage(' + gbi.ImageFormat.nameOf(format) + ', ' +
        gbi.ImageSize.nameOf(size) + ', ' + width + ', ' + toString32(address) + ');');
    }

    state.textureImage = {
      format: format,
      size: size,
      width: width,
      address: address
    };
  }

  function executeSetZImg(cmd0, cmd1, dis) {
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsDPSetDepthImage(' + toString32(address) + ');');
    }

    state.depthImage.address = address;
  }

  function executeSetCImg(cmd0, cmd1, dis) {
    var format = (cmd0 >>> 21) & 0x7;
    var size = (cmd0 >>> 19) & 0x3;
    var width = ((cmd0 >>> 0) & 0xfff) + 1;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsDPSetColorImage(' +
        gbi.ImageFormat.nameOf(format) + ', ' +
        gbi.ImageSize.nameOf(size) + ', ' +
        width + ', ' + toString32(address) + ');');
    }

    state.colorImage = {
      format: format,
      size: size,
      width: width,
      address: address
    };
  }

  function executeGBI0_Vertex(cmd0, cmd1, dis) {
    var n = ((cmd0 >>> 20) & 0xf) + 1;
    var v0 = (cmd0 >>> 16) & 0xf;
    //var length = (cmd0 >>>  0) & 0xffff;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsSPVertex(' + toString32(address) + ', ' + n + ', ' + v0 + ');');
    }

    executeVertexImpl(v0, n, address, dis);
  }

  function executeVertex_GBI0_WR(cmd0, cmd1, dis) {
    var n = ((cmd0 >>> 9) & 0x7f);
    var v0 = ((cmd0 >>> 16) & 0xff) / 5;
    //var length = (cmd0 >>> 0) & 0x1ff;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsSPVertex(' + toString32(address) + ', ' + n + ', ' + v0 + ');');
    }

    executeVertexImpl(v0, n, address, dis);
  }

  function executeGBI1_Vertex(cmd0, cmd1, dis) {
    var v0 = ((cmd0 >>> 16) & 0xff) / config.vertexStride;
    var n = ((cmd0 >>> 10) & 0x3f);
    //var length = (cmd0 >>>  0) & 0x3ff;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsSPVertex(' + toString32(address) + ', ' + n + ', ' + v0 + ');');
    }

    executeVertexImpl(v0, n, address, dis);
  }

  function executeGBI1_ModifyVtx(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPModifyVertex(???);');
    }

    // FIXME!
  }

  function getAlphaCompareType() {
    return state.rdpOtherModeL & gbi.G_AC_MASK;
  }

  function getCoverageTimesAlpha() {
    // fragment coverage (0) or alpha (1)?
    return (state.rdpOtherModeL & gbi.RenderMode.CVG_X_ALPHA) !== 0;
  }

  function getAlphaCoverageSelect() {
    // use fragment coverage * fragment alpha
    return (state.rdpOtherModeL & gbi.RenderMode.ALPHA_CVG_SEL) !== 0;
  }

  function getCycleType() {
    return state.rdpOtherModeH & gbi.G_CYC_MASK;
  }

  function getTextureFilterType() {
    return state.rdpOtherModeH & gbi.G_TF_MASK;
  }

  function getTextureLUTType() {
    return state.rdpOtherModeH & gbi.G_TT_MASK;
  }

  function logGLCall(functionName, args) {
    console.log("gl." + functionName + "(" +
      WebGLDebugUtils.glFunctionArgsToString(functionName, args) + ")");
  }

  function initWebGL(canvas) {
    if (gl) {
      return;
    }

    try {
      // Try to grab the standard context. If it fails, fallback to experimental.
      gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");

      //gl = WebGLDebugUtils.makeDebugContext(gl, undefined, logGLCall);
    } catch (e) {}

    // If we don't have a GL context, give up now
    if (!gl) {
      alert("Unable to initialize WebGL. Your browser may not support it.");
    }
  }

  var fillShaderProgram;
  var fill_vertexPositionAttribute;
  var fill_uPMatrix;
  var fill_uFillColor;

  var blitShaderProgram;
  var blit_vertexPositionAttribute;
  var blit_texCoordAttribute;
  var blit_uSampler;

  var rectVerticesBuffer;
  var n64PositionsBuffer;
  var n64ColorsBuffer;
  var n64UVBuffer;

  const kBlendModeOpaque = 0;
  const kBlendModeAlphaTrans = 1;
  const kBlendModeFade = 2;

  function setProgramState(positions, colours, coords, texture, tex_gen_enabled) {
    // fragment coverage (0) or alpha (1)?
    var cvg_x_alpha = getCoverageTimesAlpha();
    // use fragment coverage * fragment alpha
    var alpha_cvg_sel = getAlphaCoverageSelect();

    var cycle_type = getCycleType();
    if (cycle_type < gbi.CycleType.G_CYC_COPY) {
      var blend_mode = state.rdpOtherModeL >> gbi.G_MDSFT_BLENDER;
      var active_blend_mode = (cycle_type === gbi.CycleType.G_CYC_2CYCLE ? blend_mode : (
        blend_mode >>> 2)) & 0x3333;
      var mode = kBlendModeOpaque;

      switch (active_blend_mode) {
        case 0x0000: //G_BL_CLR_IN,G_BL_A_IN,G_BL_CLR_IN,G_BL_1MA
          mode = kBlendModeOpaque;
          break;
        case 0x0010: //G_BL_CLR_IN,G_BL_A_IN,G_BL_CLR_MEM,G_BL_1MA
        case 0x0011: //G_BL_CLR_IN,G_BL_A_IN,G_BL_CLR_MEM,G_BL_A_MEM
          // These modes either do a weighted sum of coverage (or coverage and alpha) or a plain alpha blend
          if (!alpha_cvg_sel || cvg_x_alpha) // If alpha_cvg_sel is 0, or if we're multiplying by fragment alpha, then we have alpha to blend with
            mode = kBlendModeAlphaTrans;
          break;

        case 0x0110: //G_BL_CLR_IN,G_BL_A_FOG,G_BL_CLR_MEM,G_BL_1MA, alpha_cvg_sel:false cvg_x_alpha:false
          // FIXME: this needs to blend the input colour with the fog alpha, but we don't compute this yet.
          mode = kBlendModeOpaque;
          break;

        case 0x0302: //G_BL_CLR_IN,G_BL_0,G_BL_CLR_IN,G_BL_1
          // This blend mode doesn't use the alpha value
          mode = kBlendModeOpaque;
          break;
        case 0x0310: //G_BL_CLR_IN,G_BL_0,G_BL_CLR_MEM,G_BL_1MA, alpha_cvg_sel:false cvg_x_alpha:false
          mode = kBlendModeFade;
          break;

        default:
          logger.log(toString16(active_blend_mode) + ' : ' + gbi.blendOpText(active_blend_mode) +
            ', alpha_cvg_sel:' + alpha_cvg_sel + ', cvg_x_alpha:' + cvg_x_alpha);
          mode = kBlendModeOpaque;
          break;
      }

      if (mode == kBlendModeAlphaTrans) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.blendEquation(gl.FUNC_ADD);
        gl.enable(gl.BLEND);
      } else if (mode == kBlendModeFade) {
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.blendEquation(gl.FUNC_ADD);
        gl.enable(gl.BLEND);
      } else {
        gl.disable(gl.BLEND);
      }
    } else {
      // No blending in copy/fill modes, although we do alpha thresholding below
      gl.disable(gl.BLEND);
    }

    var alpha_threshold = -1.0;

    if ((getAlphaCompareType() === gbi.AlphaCompare.G_AC_THRESHOLD)) {
      // If using cvg, then there's no alpha value to work with
      if (!alpha_cvg_sel) {
        alpha_threshold = ((state.blendColor >>> 0) & 0xff) / 255.0;
      }
      // } else if (cvg_x_alpha) {
      // Going over 0x70 brakes OOT, but going lesser than that makes lines on games visible...ex: Paper Mario.
      // Also going over 0x30 breaks the birds in Tarzan :(. Need to find a better way to leverage this.
      // sceGuAlphaFunc(GU_GREATER, 0x70, 0xff);
      // sceGuEnable(GU_ALPHA_TEST);
    }

    var shader = getCurrentN64Shader(cycle_type, alpha_threshold);
    gl.useProgram(shader.program);

    // aVertexPosition
    gl.enableVertexAttribArray(shader.vertexPositionAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, n64PositionsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.vertexAttribPointer(shader.vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);

    // aVertexColor
    gl.enableVertexAttribArray(shader.vertexColorAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, n64ColorsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colours, gl.STATIC_DRAW);
    gl.vertexAttribPointer(shader.vertexColorAttribute, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // aTextureCoord
    gl.enableVertexAttribArray(shader.texCoordAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, n64UVBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, coords, gl.STATIC_DRAW);
    gl.vertexAttribPointer(shader.texCoordAttribute, 2, gl.FLOAT, false, 0, 0);

    // uSampler
    if (texture) {
      var uv_offset_u = texture.left;
      var uv_offset_v = texture.top;
      var uv_scale_u = 1.0 / texture.nativeWidth;
      var uv_scale_v = 1.0 / texture.nativeHeight;

      // Horrible hack for wetrix. For some reason uvs come out 2x what they
      // should be. Current guess is that it's getting G_TX_CLAMP with a shift
      // of 0 which is causing this
      if (texture.width === 56 && texture.height === 29) {
        uv_scale_u *= 0.5;
        uv_scale_v *= 0.5;
      }

      // When texture coordinates are generated, they're already correctly
      // scaled. Maybe they should be generated in this coord space?
      if (tex_gen_enabled) {
        uv_scale_u = 1;
        uv_scale_v = 1;
        uv_offset_u = 0;
        uv_offset_v = 0;
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      gl.uniform1i(shader.uSamplerUniform, 0);

      gl.uniform2f(shader.uTexScaleUniform, uv_scale_u, uv_scale_v);
      gl.uniform2f(shader.uTexOffsetUniform, uv_offset_u, uv_offset_v);

      if (getTextureFilterType() == gbi.TextureFilter.G_TF_POINT) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
      }
    }

    gl.uniform4f(shader.uPrimColorUniform,
      ((state.primColor >>> 24) & 0xff) / 255.0,
      ((state.primColor >>> 16) & 0xff) / 255.0,
      ((state.primColor >>> 8) & 0xff) / 255.0,
      ((state.primColor >>> 0) & 0xff) / 255.0);
    gl.uniform4f(shader.uEnvColorUniform,
      ((state.envColor >>> 24) & 0xff) / 255.0,
      ((state.envColor >>> 16) & 0xff) / 255.0,
      ((state.envColor >>> 8) & 0xff) / 255.0,
      ((state.envColor >>> 0) & 0xff) / 255.0);
  }

  function flushTris(num_tris) {
    var cycle_type = getCycleType();
    var texture;
    var tex_gen_enabled = false;

    if (state.geometryMode.texture) {
      texture = lookupTexture(state.texture.tile);
      tex_gen_enabled = state.geometryMode.lighting &&
        state.geometryMode.textureGen;
    }

    setProgramState(triangleBuffer.positions,
      triangleBuffer.colours,
      triangleBuffer.coords,
      texture,
      tex_gen_enabled);

    initDepth();

    // texture filter

    if (state.geometryMode.cullFront || state.geometryMode.cullBack) {
      gl.enable(gl.CULL_FACE);
      var mode = (state.geometryMode.cullFront) ? gl.FRONT : gl.BACK;
      gl.cullFace(mode);
    } else {
      gl.disable(gl.CULL_FACE);
    }

    gl.drawArrays(gl.TRIANGLES, 0, num_tris);
    //gl.drawArrays(gl.LINE_STRIP, 0, num_tris);
  }

  function fillRect(x0, y0, x1, y1, color) {
    // multiply by state.viewport.trans/scale
    var screen0 = convertN64ToCanvas([x0, y0]);
    var screen1 = convertN64ToCanvas([x1, y1]);

    var vertices = [
      screen1[0], screen1[1], 0.0,
      screen0[0], screen1[1], 0.0,
      screen1[0], screen0[1], 0.0,
      screen0[0], screen0[1], 0.0
    ];

    gl.useProgram(fillShaderProgram);

    // aVertexPosition
    gl.enableVertexAttribArray(fill_vertexPositionAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, rectVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(fill_vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0);

    // uPMatrix
    gl.uniformMatrix4fv(fill_uPMatrix, false, canvas2dMatrix.elems);

    // uFillColor
    gl.uniform4f(fill_uFillColor, color.r, color.g, color.b, color.a);

    // Disable depth testing
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(false);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function texRect(tileIdx, x0, y0, x1, y1, s0, t0, s1, t1, flip) {
    // TODO: check scissor
    var texture = lookupTexture(tileIdx);

    // multiply by state.viewport.trans/scale
    var screen0 = convertN64ToDisplay([x0, y0]);
    var screen1 = convertN64ToDisplay([x1, y1]);
    var depth_source_prim = (state.rdpOtherModeL & gbi.DepthSource.G_ZS_PRIM) !== 0;
    var depth = depth_source_prim ? state.primDepth : 0.0;

    var vertices = [
      screen0[0], screen0[1], depth, 1.0,
      screen1[0], screen0[1], depth, 1.0,
      screen0[0], screen1[1], depth, 1.0,
      screen1[0], screen1[1], depth, 1.0
    ];

    var uvs;

    if (flip) {
      uvs = [
        s0, t0,
        s0, t1,
        s1, t0,
        s1, t1,
      ];
    } else {
      uvs = [
        s0, t0,
        s1, t0,
        s0, t1,
        s1, t1,
      ];
    }

    var colours = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];

    setProgramState(new Float32Array(vertices),
                    new Uint32Array(colours),
                    new Float32Array(uvs), texture, false /*tex_gen_enabled*/ );

    gl.disable(gl.CULL_FACE);

    var depth_enabled = depth_source_prim ? true : false;
    if (depth_enabled) {
      initDepth();
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function copyBackBufferToFrontBuffer(texture) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    var vertices = [
      -1.0, -1.0, 0.0, 1.0,
      1.0, -1.0, 0.0, 1.0,
      -1.0, 1.0, 0.0, 1.0,
      1.0, 1.0, 0.0, 1.0
    ];

    var uvs = [
      0.0, 0.0,
      1.0, 0.0,
      0.0, 1.0,
      1.0, 1.0
    ];

    gl.useProgram(blitShaderProgram);

    // aVertexPosition
    gl.enableVertexAttribArray(blit_vertexPositionAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, n64PositionsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(blit_vertexPositionAttribute, 4, gl.FLOAT, false, 0, 0);

    // aTextureCoord
    gl.enableVertexAttribArray(blit_texCoordAttribute);
    gl.bindBuffer(gl.ARRAY_BUFFER, n64UVBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
    gl.vertexAttribPointer(blit_texCoordAttribute, 2, gl.FLOAT, false, 0, 0);

    // uSampler
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(blit_uSampler, 0);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function initDepth() {

    // Fixes Zfighting issues we have on the PSP.
    //if (gRDPOtherMode.zmode == 3) ...

    // Disable depth testing
    var zgeom_mode = (state.geometryMode.zbuffer) !== 0;
    var zcmp_rendermode = (state.rdpOtherModeL & gbi.RenderMode.Z_CMP) !== 0;
    var zupd_rendermode = (state.rdpOtherModeL & gbi.RenderMode.Z_UPD) !== 0;

    if ((zgeom_mode && zcmp_rendermode) || zupd_rendermode) {
      gl.enable(gl.DEPTH_TEST);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }

    gl.depthMask(zupd_rendermode);
  }

  // A lot of functions are common between all ucodes
  // TOOD(hulkholden): Make this a Map?
  const ucode_common = {
    0xe4: executeTexRect,
    0xe5: executeTexRectFlip,
    0xe6: executeRDPLoadSync,
    0xe7: executeRDPPipeSync,
    0xe8: executeRDPTileSync,
    0xe9: executeRDPFullSync,
    0xea: executeSetKeyGB,
    0xeb: executeSetKeyR,
    0xec: executeSetConvert,
    0xed: executeSetScissor,
    0xee: executeSetPrimDepth,
    0xef: executeSetRDPOtherMode,
    0xf0: executeLoadTLut,
    0xf2: executeSetTileSize,
    0xf3: executeLoadBlock,
    0xf4: executeLoadTile,
    0xf5: executeSetTile,
    0xf6: executeFillRect,
    0xf7: executeSetFillColor,
    0xf8: executeSetFogColor,
    0xf9: executeSetBlendColor,
    0xfa: executeSetPrimColor,
    0xfb: executeSetEnvColor,
    0xfc: executeSetCombine,
    0xfd: executeSetTImg,
    0xfe: executeSetZImg,
    0xff: executeSetCImg
  };

  const ucode_gbi0 = {
    0x00: executeGBI1_SpNoop,
    0x01: executeGBI1_Matrix,
    0x03: executeGBI1_MoveMem,
    0x04: executeGBI0_Vertex,
    0x06: executeGBI1_DL,
    0x09: executeGBI1_Sprite2DBase,

    0xb0: executeGBI1_BranchZ, // GBI1 only?
    0xb1: executeGBI1_Tri2, // GBI1 only?
    0xb2: executeGBI1_RDPHalf_Cont,
    0xb3: executeGBI1_RDPHalf_2,
    0xb4: executeGBI1_RDPHalf_1,
    0xb5: executeGBI1_Line3D,
    0xb6: executeGBI1_ClrGeometryMode,
    0xb7: executeGBI1_SetGeometryMode,
    0xb8: executeGBI1_EndDL,
    0xb9: executeGBI1_SetOtherModeL,
    0xba: executeGBI1_SetOtherModeH,
    0xbb: executeGBI1_Texture,
    0xbc: executeGBI1_MoveWord,
    0xbd: executeGBI1_PopMatrix,
    0xbe: executeGBI1_CullDL,
    0xbf: executeGBI1_Tri1,
    0xc0: executeGBI1_Noop
  };

  const ucode_gbi1 = {
    0x00: executeGBI1_SpNoop,
    0x01: executeGBI1_Matrix,
    0x03: executeGBI1_MoveMem,
    0x04: executeGBI1_Vertex,
    0x06: executeGBI1_DL,
    0x09: executeGBI1_Sprite2DBase,

    0xb0: executeGBI1_BranchZ,
    0xb1: executeGBI1_Tri2,
    0xb2: executeGBI1_ModifyVtx,
    0xb3: executeGBI1_RDPHalf_2,
    0xb4: executeGBI1_RDPHalf_1,
    0xb5: executeGBI1_Line3D,
    0xb6: executeGBI1_ClrGeometryMode,
    0xb7: executeGBI1_SetGeometryMode,
    0xb8: executeGBI1_EndDL,
    0xb9: executeGBI1_SetOtherModeL,
    0xba: executeGBI1_SetOtherModeH,
    0xbb: executeGBI1_Texture,
    0xbc: executeGBI1_MoveWord,
    0xbd: executeGBI1_PopMatrix,
    0xbe: executeGBI1_CullDL,
    0xbf: executeGBI1_Tri1,
    0xc0: executeGBI1_Noop
  };

  const ucode_gbi2 = {
    0x00: executeGBI2_Noop,
    0x01: executeGBI2_Vertex,
    0x02: executeGBI2_ModifyVtx,
    0x03: executeGBI2_CullDL,
    0x04: executeGBI2_BranchZ,
    0x05: executeGBI2_Tri1,
    0x06: executeGBI2_Tri2,
    0x07: executeGBI2_Quad,
    0x08: executeGBI2_Line3D,

    // 0xd3: executeGBI2_Special1,
    // 0xd4: executeGBI2_Special2,
    // 0xd5: executeGBI2_Special3,
    0xd6: executeGBI2_DmaIo,
    0xd7: executeGBI2_Texture,
    0xd8: executeGBI2_PopMatrix,
    0xd9: executeGBI2_GeometryMode,
    0xda: executeGBI2_Matrix,
    0xdb: executeGBI2_MoveWord,
    0xdc: executeGBI2_MoveMem,
    0xdd: executeGBI2_LoadUcode,
    0xde: executeGBI2_DL,
    0xdf: executeGBI2_EndDL,

    0xe0: executeGBI2_SpNoop,
    0xe1: executeGBI2_RDPHalf_1,
    0xe2: executeGBI2_SetOtherModeL,
    0xe3: executeGBI2_SetOtherModeH,

    0xf1: executeGBI2_RDPHalf_2
  };

  function executeGBI2_Noop(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsDPNoOp();');
    }
  }

  function executeGBI2_Vertex(cmd0, cmd1, dis) {
    var vend = ((cmd0) & 0xff) >> 1;
    var n = (cmd0 >>> 12) & 0xff;
    var v0 = vend - n;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      dis.text('gsSPVertex(' + toString32(address) + ', ' + n + ', ' + v0 + ');');
    }

    executeVertexImpl(v0, n, address, dis);
  }

  function executeGBI2_ModifyVtx(cmd0, cmd1, dis) {
    var vtx = (cmd0 >>> 1) & 0x7fff;
    var offset = (cmd0 >>> 16) & 0xff;
    var value = cmd1;

    if (dis) {
      dis.text('gsSPModifyVertex(' + vtx + ',' +
        gbi.ModifyVtx.nameOf(offset) + ',' +
        toString32(value) + ');');
    }

    // Cures crash after swinging in Mario Golf
    if (vtx >= state.projectedVertices.length) {
      hleHalt('crazy vertex index');
      return;
    }

    var vertex = state.projectedVertices[vtx];

    switch (offset) {
      case gbi.ModifyVtx.G_MWO_POINT_RGBA:
        hleHalt('unhandled modifyVtx');
        break;

      case gbi.ModifyVtx.G_MWO_POINT_ST:
        // u/v are signed
        var u = (value >> 16);
        var v = ((value & 0xffff) << 16) >> 16;
        vertex.set = true;
        vertex.u = u * state.texture.scaleS / 32.0;
        vertex.v = v * state.texture.scaleT / 32.0;
        break;

      case gbi.ModifyVtx.G_MWO_POINT_XYSCREEN:
        hleHalt('unhandled modifyVtx');
        break;

      case gbi.ModifyVtx.G_MWO_POINT_ZSCREEN:
        hleHalt('unhandled modifyVtx');
        break;

      default:
        hleHalt('unhandled modifyVtx');
        break;
    }
  }

  function executeGBI2_CullDL(cmd0, cmd1, dis) {}

  function executeGBI2_BranchZ(cmd0, cmd1, dis) {}

  function executeGBI2_Tri1(cmd0, cmd1, dis) {
    var kTri1 = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var flag = (cmd1 >>> 24) & 0xff;
      var v0idx = (cmd0 >>> 17) & 0x7f;
      var v1idx = (cmd0 >>> 9) & 0x7f;
      var v2idx = (cmd0 >>> 1) & 0x7f;

      if (dis) {
        dis.text('gsSP1Triangle(' + v0idx + ', ' + v1idx + ', ' + v2idx + ', ' + flag + ');');
      }

      triangleBuffer.pushTri(verts[v0idx], verts[v1idx], verts[v2idx], triIdx);
      triIdx++;

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;

      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kTri1 && triIdx < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeGBI2_Tri2(cmd0, cmd1, dis) {
    var kTri2 = cmd0 >>> 24;
    var stride = config.vertexStride;
    var verts = state.projectedVertices;

    var triIdx = 0;

    var pc = state.pc;
    do {
      var v0idx = (cmd1 >>> 1) & 0x7f;
      var v1idx = (cmd1 >>> 9) & 0x7f;
      var v2idx = (cmd1 >>> 17) & 0x7f;
      var v3idx = (cmd0 >>> 1) & 0x7f;
      var v4idx = (cmd0 >>> 9) & 0x7f;
      var v5idx = (cmd0 >>> 17) & 0x7f;

      if (dis) {
        dis.text('gsSP1Triangle2(' + v0idx + ',' + v1idx + ',' + v2idx + ', ' +
          v3idx + ',' + v4idx + ',' + v5idx + ');');
      }

      triangleBuffer.pushTri(verts[v0idx], verts[v1idx], verts[v2idx], triIdx);
      triIdx++;
      triangleBuffer.pushTri(verts[v3idx], verts[v4idx], verts[v5idx], triIdx);
      triIdx++;

      cmd0 = ram_dv.getUint32(pc + 0);
      cmd1 = ram_dv.getUint32(pc + 4);
      ++debugCurrentOp;
      pc += 8;
      // NB: process triangles individually when disassembling
    } while ((cmd0 >>> 24) === kTri2 && triIdx < kMaxTris && !dis);

    state.pc = pc - 8;
    --debugCurrentOp;

    flushTris(triIdx * 3);
  }

  function executeGBI2_Quad(cmd0, cmd1, dis) {}

  function executeGBI2_Line3D(cmd0, cmd1, dis) {}

  function executeGBI2_DmaIo(cmd0, cmd1, dis) {}

  function executeGBI2_Texture(cmd0, cmd1, dis) {
    var xparam = (cmd0 >>> 16) & 0xff;
    var level = (cmd0 >>> 11) & 0x3;
    var tileIdx = (cmd0 >>> 8) & 0x7;
    var on = (cmd0 >>> 1) & 0x01; // NB: uses bit 1
    var s = calcTextureScale(((cmd1 >>> 16) & 0xffff));
    var t = calcTextureScale(((cmd1 >>> 0) & 0xffff));

    if (dis) {
      var s_text = s.toString();
      var t_text = t.toString();
      var tt = gbi.getTileText(tileIdx);

      if (xparam !== 0) {
        dis.text('gsSPTextureL(' +
          s_text + ', ' + t_text + ', ' +
          level + ', ' + xparam + ', ' + tt + ', ' + on + ');');
      } else {
        dis.text('gsSPTexture(' +
          s_text + ', ' + t_text + ', ' +
          level + ', ' + tt + ', ' + on + ');');
      }
    }

    state.texture.level = level;
    state.texture.tile = tileIdx;
    state.texture.scaleS = s;
    state.texture.scaleT = t;

    if (on) {
      state.geometryModeBits |= gbi.GeometryModeGBI2.G_TEXTURE_ENABLE;
    } else {
      state.geometryModeBits &= ~gbi.GeometryModeGBI2.G_TEXTURE_ENABLE;
    }
    updateGeometryModeFromBits(gbi.GeometryModeGBI2);
  }

  function executeGBI2_GeometryMode(cmd0, cmd1, dis) {
    var arg0 = cmd0 & 0x00ffffff;
    var arg1 = cmd1;

    if (dis) {
      dis.text('gsSPGeometryMode(~(' +
        gbi.getGeometryModeFlagsText(gbi.GeometryModeGBI2, ~arg0) + '),' +
        gbi.getGeometryModeFlagsText(gbi.GeometryModeGBI2, arg1) + ');');
    }

    state.geometryModeBits &= arg0;
    state.geometryModeBits |= arg1;
    updateGeometryModeFromBits(gbi.GeometryModeGBI2);
  }

  function executeGBI2_Matrix(cmd0, cmd1, dis) {
    var address = rdpSegmentAddress(cmd1);
    var push = ((cmd0) & 0x1) === 0;
    var replace = (cmd0 >>> 1) & 0x1;
    var projection = (cmd0 >>> 2) & 0x1;

    var matrix = loadMatrix(address);

    if (dis) {
      var t = '';
      t += projection ? 'G_MTX_PROJECTION' : 'G_MTX_MODELVIEW';
      t += replace ? '|G_MTX_LOAD' : '|G_MTX_MUL';
      t += push ? '|G_MTX_PUSH' : ''; //'|G_MTX_NOPUSH';

      dis.text('gsSPMatrix(' + toString32(address) + ', ' + t + ');');
      dis.tip(previewMatrix(matrix));
    }

    var stack = projection ? state.projection : state.modelview;

    if (!replace) {
      matrix = stack[stack.length - 1].multiply(matrix);
    }

    if (push) {
      stack.push(matrix);
    } else {
      stack[stack.length - 1] = matrix;
    }
  }

  function executeGBI2_PopMatrix(cmd0, cmd1, dis) {
    // FIXME: not sure what bit this is
    //var projection =  ??;
    var projection = 0;

    if (dis) {
      var t = '';
      t += projection ? 'G_MTX_PROJECTION' : 'G_MTX_MODELVIEW';
      dis.text('gsSPPopMatrix(' + t + ');');
    }

    var stack = projection ? state.projection : state.modelview;
    if (stack.length > 0) {
      stack.pop();
    }
  }

  function executeGBI2_MoveWord(cmd0, cmd1, dis) {
    var type = (cmd0 >>> 16) & 0xff;
    var offset = (cmd0) & 0xffff;
    var value = cmd1;

    if (dis) {
      var text = 'gMoveWd(' + gbi.MoveWord.nameOf(type) + ', ' +
        toString16(offset) + ', ' + toString32(value) + ');';

      switch (type) {
        case gbi.MoveWord.G_MW_NUMLIGHT:
          var v = Math.floor(value / 24);
          text = 'gsSPNumLights(' + gbi.NumLights.nameOf(v) + ');';
          break;
        case gbi.MoveWord.G_MW_SEGMENT:
          {
            var v = value === 0 ? '0' : toString32(value);
            text = 'gsSPSegment(' + ((offset >>> 2) & 0xf) + ', ' + v + ');';
          }
          break;
      }
      dis.text(text);
    }

    switch (type) {
      // case gbi.MoveWord.G_MW_MATRIX:  unimplemented(cmd0,cmd1); break;
      case gbi.MoveWord.G_MW_NUMLIGHT:
        state.numLights = Math.floor(value / 24);
        break;
      case gbi.MoveWord.G_MW_CLIP:
        /*unimplemented(cmd0,cmd1);*/ break;
      case gbi.MoveWord.G_MW_SEGMENT:
        state.segments[((offset >>> 2) & 0xf)] = value;
        break;
      case gbi.MoveWord.G_MW_FOG:
        /*unimplemented(cmd0,cmd1);*/ break;
      case gbi.MoveWord.G_MW_LIGHTCOL:
        /*unimplemented(cmd0,cmd1);*/ break;
        // case gbi.MoveWord.G_MW_POINTS:    unimplemented(cmd0,cmd1); break;
      case gbi.MoveWord.G_MW_PERSPNORM:
        /*unimplemented(cmd0,cmd1);*/ break;
      default:
        unimplemented(cmd0, cmd1);
        break;
    }
  }

  function previewGBI2_MoveMem(type, length, address, dis) {
    var tip = '';
    for (var i = 0; i < length; ++i) {
      tip += toHex(ram_dv.getUint8(address + i), 8) + ' ';
    }
    tip += '<br>';

    switch (type) {
      // TODO(hulkholden): MoveMemGBI2?
      case gbi.MoveMemGBI1.G_MV_VIEWPORT:
        tip += previewViewport(address);
        break;

      case gbi.MoveMemGBI1.G_MV_L0:
      case gbi.MoveMemGBI1.G_MV_L1:
      case gbi.MoveMemGBI1.G_MV_L2:
      case gbi.MoveMemGBI1.G_MV_L3:
      case gbi.MoveMemGBI1.G_MV_L4:
      case gbi.MoveMemGBI1.G_MV_L5:
      case gbi.MoveMemGBI1.G_MV_L6:
      case gbi.MoveMemGBI1.G_MV_L7:
        tip += previewLight(address);
        break;
    }

    dis.tip(tip);
  }

  function executeGBI2_MoveMem(cmd0, cmd1, dis) {
    var type = cmd0 & 0xfe;
    //var length = (cmd0>>> 8) & 0xffff;
    var address = rdpSegmentAddress(cmd1);
    var length = 0; // FIXME

    if (dis) {
      var address_str = toString32(address);

      var type_str = gbi.MoveMemGBI2.nameOf(type);
      var text = 'gsDma1p(G_MOVEMEM, ' + address_str + ', ' + length + ', ' + type_str + ');';

      switch (type) {
        case gbi.MoveMemGBI2.G_GBI2_MV_VIEWPORT:
          text = 'gsSPViewport(' + address_str + ');';
          break;
        case gbi.MoveMemGBI2.G_GBI2_MV_LIGHT:
          var offset2 = (cmd0 >>> 5) & 0x3fff;
          switch (offset2) {
            case 0x00:
            case 0x18:
              // lookat?
              break;
            default:
              //
              var light_idx = Math.floor((offset2 - 0x30) / 0x18);
              text += ' // (light ' + light_idx + ')';
              break;
          }
          break;
      }

      dis.text(text);
      length = 32; // FIXME: Just show some data
      previewGBI2_MoveMem(type, length, address, dis);
    }

    switch (type) {
      case gbi.MoveMemGBI2.G_GBI2_MV_VIEWPORT:
        moveMemViewport(address);
        break;
      case gbi.MoveMemGBI2.G_GBI2_MV_LIGHT:
        var offset2 = (cmd0 >>> 5) & 0x3fff;
        switch (offset2) {
          case 0x00:
          case 0x18:
            // lookat?
            break;
          default:
            var light_idx = Math.floor((offset2 - 0x30) / 0x18);
            moveMemLight(light_idx, address);
            break;
        }
        break;

      default:
        hleHalt('unknown movemen: ' + type.toString(16));
    }
  }

  function executeGBI2_LoadUcode(cmd0, cmd1, dis) {}

  function executeGBI2_DL(cmd0, cmd1, dis) {
    var param = (cmd0 >>> 16) & 0xff;
    var address = rdpSegmentAddress(cmd1);

    if (dis) {
      var fn = (param === gbi.G_DL_PUSH) ? 'gsSPDisplayList' : 'gsSPBranchList';
      dis.text(fn + '(<span class="dl-branch">' + toString32(address) + '</span>);');
    }

    if (param === gbi.G_DL_PUSH) {
      state.dlistStack.push({ pc: state.pc });
    }
    state.pc = address;
  }

  function executeGBI2_EndDL(cmd0, cmd1, dis) {
    if (dis) {
      dis.text('gsSPEndDisplayList();');
    }

    if (state.dlistStack.length > 0) {
      state.pc = state.dlistStack.pop().pc;
    } else {
      state.pc = 0;
    }
  }

  function executeGBI2_SetOtherModeL(cmd0, cmd1, dis) {
    var shift = (cmd0 >>> 8) & 0xff;
    var len = (cmd0 >>> 0) & 0xff;
    var data = cmd1;
    var mask = (0x80000000 >> len) >>> shift; // NB: only difference to GBI1 is how the mask is constructed

    if (dis) {
      disassembleSetOtherModeL(dis, len, shift, data);
    }

    state.rdpOtherModeL = (state.rdpOtherModeL & ~mask) | data;
  }

  function executeGBI2_SetOtherModeH(cmd0, cmd1, dis) {
    var shift = (cmd0 >>> 8) & 0xff;
    var len = (cmd0 >>> 0) & 0xff;
    var data = cmd1;
    var mask = (0x80000000 >> len) >>> shift; // NB: only difference to GBI1 is how the mask is constructed

    if (dis) {
      disassembleSetOtherModeH(dis, len, shift, data);
    }

    state.rdpOtherModeH = (state.rdpOtherModeH & ~mask) | data;
  }

  function executeGBI2_SpNoop(cmd0, cmd1, dis) {}

  function executeGBI2_RDPHalf_1(cmd0, cmd1, dis) {}

  function executeGBI2_RDPHalf_2(cmd0, cmd1, dis) {}

  // var ucode_sprite2d = {
  //   0xbe: executeSprite2dScaleFlip,
  //   0xbd: executeSprite2dDraw
  // };

  // var ucode_dkr = {
  //   0x05:  executeDMATri,
  //   0x07:  executeGBI1_DLInMem,
  // };

  function buildUCodeTables(ucode) {
    var ucode_table = ucode_gbi0;

    switch (ucode) {
      case kUCode_GBI0:
      case kUCode_GBI0_WR:
      case kUCode_GBI0_GE:
        ucode_table = ucode_gbi0;
        break;
      case kUCode_GBI1:
        ucode_table = ucode_gbi1;
        break;
      case kUCode_GBI2:
        ucode_table = ucode_gbi2;
    }

    // Build a copy of the table as an array
    var table = [];
    for (var i = 0; i < 256; ++i) {
      var fn = executeUnknown;
      if (ucode_table.hasOwnProperty(i)) {
        fn = ucode_table[i];
      } else if (ucode_common.hasOwnProperty(i)) {
        fn = ucode_common[i];
      }
      table.push(fn);
    }

    // Patch in specific overrides
    switch (ucode) {
      case kUCode_GBI0_WR:
        table[0x04] = executeVertex_GBI0_WR;
        break;
      case kUCode_GBI0_GE:
        table[0xb1] = executeTri4_GBI0;
        table[0xb2] = executeGBI1_SpNoop; // FIXME
        table[0xb4] = executeGBI1_SpNoop; // FIXME - DLParser_RDPHalf1_GoldenEye;
        break;
    }

    return table;
  }

  var last_ucode_str = '';
  var num_display_lists_since_present = 0;

  n64js.presentBackBuffer = function(ram, origin) {
    var texture;

    n64js.onPresent();

    // NB: if no display lists executed, interpret framebuffer as bytes
    if (num_display_lists_since_present === 0) {
      //logger.log('new origin: ' + toString32(origin) + ' but no display lists rendered to skipping');

      origin = (origin & 0x7ffffffe) | 0; // NB: clear top bit (make address physical). Clear bottom bit (sometimes odd valued addresses are passed through)

      var width = 320;
      var height = 240;
      var pixels = new Uint16Array(width * height); // TODO: should cache this, but at some point we'll need to deal with variable framebuffer size, so do this later.

      var srcOffset = 0;

      for (var y = 0; y < height; ++y) {
        var dstRowOffset = (height - 1 - y) * width;
        var dstOffset = dstRowOffset;

        for (var x = 0; x < width; ++x) {
          // NB: or 1 to ensure we have alpha
          pixels[dstOffset] =
            (ram[origin + srcOffset] << 8) |
            ram[origin + srcOffset + 1] |
            1;
          dstOffset += 1;
          srcOffset += 2;
        }
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_SHORT_5_5_5_1,
        pixels);
      texture = frameBufferTexture2D;
    } else {
      texture = frameBufferTexture3D;
    }

    copyBackBufferToFrontBuffer(texture);
    num_display_lists_since_present = 0;
  };

  function setViScales() {
    var width = n64js.viWidth();

    var scale_x = (n64js.viXScale() & 0xFFF) / 1024.0;
    var scale_y = (n64js.viYScale() & 0xFFF) / 2048.0;

    var h_start_reg = n64js.viHStart();
    var hstart = h_start_reg >> 16;
    var hend = h_start_reg & 0xffff;

    var v_start_reg = n64js.viVStart();
    var vstart = v_start_reg >> 16;
    var vend = v_start_reg & 0xffff;

    // Sometimes h_start_reg can be zero.. ex PD, Lode Runner, Cyber Tiger
    if (hend === hstart) {
      hend = (width / scale_x) | 0;
    }

    viWidth = (hend - hstart) * scale_x;
    viHeight = (vend - vstart) * scale_y * 1.0126582;

    // XXX Need to check PAL games.
    //if (g_ROM.TvType != OS_TV_NTSC) sRatio = 9/11.0f;

    //This corrects height in various games ex : Megaman 64, CyberTiger
    if (width > 0x300) {
      viHeight *= 2.0;
    }
  }

  /**
   * @constructor
   */
  function Disassembler() {
    this.$currentDis = $('<pre></pre>');
    this.$span = undefined;
    this.numOps = 0;
  }

  Disassembler.prototype.begin = function(pc, cmd0, cmd1, depth) {
    var indent = (new Array(depth)).join('    ');
    var pc_str = ' '; //' [' + toHex(pc,32) + '] '

    this.$span = $('<span class="hle-instr" id="I' + this.numOps + '" />');
    this.$span.append(padString(this.numOps, 5) + pc_str + toHex(cmd0, 32) + toHex(cmd1, 32) +
      ' ' + indent);
    this.$currentDis.append(this.$span);
  };

  Disassembler.prototype.text = function(t) {
    this.$span.append(t);
  };

  Disassembler.prototype.tip = function(t) {
    var $d = $('<div class="dl-tip">' + t + '</div>');
    $d.hide();
    this.$span.append($d);
  };

  Disassembler.prototype.end = function() {
    this.$span.append('<br>');
    this.numOps++;
  };

  Disassembler.prototype.finalise = function() {
    $dlistOutput.html(this.$currentDis);
    this.$currentDis.find('.dl-tip').parent().click(function() {
      $(this).find('.dl-tip').toggle();
    });
    // this.$currentDis.find('.dl-branch').click(function () {
    // });
  };

  n64js.debugDisplayListRequested = function() {
    return debugDisplayListRequested;
  };
  n64js.debugDisplayListRunning = function() {
    return debugDisplayListRunning;
  };

  function buildStateTab() {
    var $table = $('<table class="table table-condensed" style="width: auto;"></table>');
    var $tr = $('<tr />');

    for (let i in state.geometryMode) {
      if (state.geometryMode.hasOwnProperty(i)) {
        var $td = $('<td>' + i + '</td>');
        if (state.geometryMode[i]) {
          $td.css('background-color', '#AFF4BB');
        }
        $tr.append($td);
      }
    }

    $table.append($tr);
    return $table;
  }

  function buildRDPTab() {
    var l = state.rdpOtherModeL;
    var h = state.rdpOtherModeH;
    const vals = new Map([
      //var G_MDSFT_BLENDMASK = 0;
      ['alphaCompare', gbi.AlphaCompare.nameOf(l & gbi.G_AC_MASK)],
      ['depthSource', gbi.DepthSource.nameOf(l & gbi.G_ZS_MASK)],
      ['renderMode', gbi.getRenderModeText(l)],
      ['alphaDither', gbi.AlphaDither.nameOf(h & gbi.G_AD_MASK)],
      ['colorDither', gbi.ColorDither.nameOf(h & gbi.G_CD_MASK)],
      ['combineKey', gbi.CombineKey.nameOf(h & gbi.G_CK_MASK)],
      ['textureConvert', gbi.TextureConvert.nameOf(h & gbi.G_TC_MASK)],
      ['textureFilter', gbi.TextureFilter.nameOf(h & gbi.G_TF_MASK)],
      ['textureLUT', gbi.TextureLUT.nameOf(h & gbi.G_TT_MASK)],
      ['textureLOD', gbi.TextureLOD.nameOf(h & gbi.G_TL_MASK)],
      ['texturePersp', gbi.TexturePerspective.nameOf(h & gbi.G_TP_MASK)],
      ['textureDetail', gbi.TextureDetail.nameOf(h & gbi.G_TD_MASK)],
      ['cycleType', gbi.CycleType.nameOf(h & gbi.G_CYC_MASK)],
      ['pipelineMode', gbi.PipelineMode.nameOf(h & gbi.G_PM_MASK)],
    ]);

    var $table = $('<table class="table table-condensed" style="width: auto;"></table>');
    for (let [name, value] of vals) {
      let $tr = $('<tr><td>' + name + '</td><td>' + value + '</td></tr>');
      $table.append($tr);
    }
    return $table;
  }

  function buildColorsTable() {
    const colors = [
      'fillColor',
      'envColor',
      'primColor',
      'blendColor',
      'fogColor',
    ];

    var $table = $('<table class="table table-condensed" style="width: auto;"></table>');
    for (let color of colors) {
      let row = $('<tr><td>' + color + '</td><td>' + makeColorTextRGBA(state[color]) +
        '</td></tr>');
      $table.append(row);
    }
    return $table;
  }

  function buildCombinerTab() {
    var $p = $('<pre class="combine"></pre>');
    $p.append(gbi.CycleType.nameOf(getCycleType()) + '\n');
    $p.append(buildColorsTable());
    $p.append(shaders.getCombinerText(state.combine.hi, state.combine.lo));
    return $p;
  }

  function buildTexture(tileIdx) {
    var texture = lookupTexture(tileIdx);
    if (texture) {
      const kScale = 8;
      return texture.createScaledCanvas(kScale);
    }
  }

  function buildTexturesTab() {
    var $d = $('<div />');
    $d.append(buildTilesTable());
    for (let i = 0; i < 8; ++i) {
      let $t = buildTexture(i);
      if ($t) {
        $d.append($t);
      }
    }
    return $d;
  }

  function buildTilesTable() {
    const tile_fields = [
      'tile #',
      'format',
      'size',
      'line',
      'tmem',
      'palette',
      'cm_s',
      'mask_s',
      'shift_s',
      'cm_t',
      'mask_t',
      'shift_t',
      'left',
      'top',
      'right',
      'bottom'
    ];

    var $table = $('<table class="table table-condensed" style="width: auto"></table>');
    var $tr = $('<tr><th>' + tile_fields.join('</th><th>') + '</th></tr>');
    $table.append($tr);

    for (let i = 0; i < state.tiles.length; ++i) {
      var tile = state.tiles[i];

      // Ignore any tiles that haven't been set up.
      if (tile.format === -1) {
        continue;
      }

      var vals = [];
      vals.push(i);
      vals.push(gbi.ImageFormat.nameOf(tile.format));
      vals.push(gbi.ImageSize.nameOf(tile.size));
      vals.push(tile.line);
      vals.push(tile.tmem);
      vals.push(tile.palette);
      vals.push(gbi.getClampMirrorWrapText(tile.cm_s));
      vals.push(tile.mask_s);
      vals.push(tile.shift_s);
      vals.push(gbi.getClampMirrorWrapText(tile.cm_t));
      vals.push(tile.mask_t);
      vals.push(tile.shift_t);
      vals.push(tile.left);
      vals.push(tile.top);
      vals.push(tile.right);
      vals.push(tile.bottom);

      $tr = $('<tr><td>' + vals.join('</td><td>') + '</td></tr>');
      $table.append($tr);
    }

    return $table;
  }

  function buildVerticesTab() {
    const vtx_fields = [
      'vtx #',
      'x',
      'y',
      'z',
      'px',
      'py',
      'pz',
      'pw',
      'color',
      'u',
      'v'
    ];

    var $table = $('<table class="table table-condensed" style="width: auto"></table>');
    var $tr = $('<tr><th>' + vtx_fields.join('</th><th>') + '</th></tr>');
    $table.append($tr);

    for (let i = 0; i < state.projectedVertices.length; ++i) {
      var vtx = state.projectedVertices[i];
      if (!vtx.set) {
        continue;
      }

      var x = vtx.pos.elems[0] / vtx.pos.elems[3];
      var y = vtx.pos.elems[1] / vtx.pos.elems[3];
      var z = vtx.pos.elems[2] / vtx.pos.elems[3];

      var vals = [];
      vals.push(i);
      vals.push(x.toFixed(3));
      vals.push(y.toFixed(3));
      vals.push(z.toFixed(3));
      vals.push(vtx.pos.elems[0].toFixed(3));
      vals.push(vtx.pos.elems[1].toFixed(3));
      vals.push(vtx.pos.elems[2].toFixed(3));
      vals.push(vtx.pos.elems[3].toFixed(3));
      vals.push(makeColorTextABGR(vtx.color));
      vals.push(vtx.u.toFixed(3));
      vals.push(vtx.v.toFixed(3));

      $tr = $('<tr><td>' + vals.join('</td><td>') + '</td></tr>');
      $table.append($tr);
    }

    return $table;
  }

  function updateStateUI() {
    $dlistState.find('#dl-geometrymode-content').html(buildStateTab());
    $dlistState.find('#dl-vertices-content').html(buildVerticesTab());
    $dlistState.find('#dl-textures-content').html(buildTexturesTab());
    $dlistState.find('#dl-combiner-content').html(buildCombinerTab());
    $dlistState.find('#dl-rdp-content').html(buildRDPTab());
  }

  function showDebugDisplayListUI() {
    $('.debug').show();
    $('#dlist-tab').tab('show');
  }

  function hideDebugDisplayListUI() {
    $('.debug').hide();
  }

  n64js.toggleDebugDisplayList = function() {
    if (debugDisplayListRunning) {
      hideDebugDisplayListUI();
      debugBailAfter = -1;
      debugDisplayListRunning = false;
      n64js.toggleRun();
    } else {
      showDebugDisplayListUI();
      debugDisplayListRequested = true;
    }
  };

  // This is acalled repeatedly so that we can update the ui.
  // We can return false if we don't render anything, but it's useful to keep re-rendering so that we can plot a framerate graph
  n64js.debugDisplayList = function() {
    if (debugStateTimeShown == -1) {
      // Build some disassembly for this display list
      var disassembler = new Disassembler();
      processDList(debugLastTask, disassembler, -1);
      disassembler.finalise();

      // Update the scrubber based on the new length of disassembly
      debugNumOps = disassembler.numOps > 0 ? (disassembler.numOps - 1) : 0;
      setScrubRange(debugNumOps);

      // If debugBailAfter hasn't been set (e.g. by hleHalt), stop at the end of the list
      var time_to_show = (debugBailAfter == -1) ? debugNumOps : debugBailAfter;
      setScrubTime(time_to_show);
    }

    // Replay the last display list using the captured task/ram
    processDList(debugLastTask, null, debugBailAfter);

    // Only update the state display when needed, otherwise it's impossible to
    // debug the dom in Chrome
    if (debugStateTimeShown !== debugBailAfter) {
      updateStateUI();
      debugStateTimeShown = debugBailAfter;
    }

    return true;
  };

  function hleGraphics(task) {
    // Bodgily track these parameters so that we can call again with the same params.
    debugLastTask = task;

    // Force the cpu to stop at the point that we render the display list.
    if (debugDisplayListRequested) {
      debugDisplayListRequested = false;

      // Finally, break execution so we can keep replaying the display list
      // before any other state changes.
      n64js.breakEmulationForDisplayListDebug();

      debugStateTimeShown = -1;
      debugDisplayListRunning = true;
    }

    processDList(task, null, -1);
  }

  function processDList(task, disassembler, bail_after) {
    // Update a counter to tell the video code that we've rendered something since the last vbl.
    ++num_display_lists_since_present;
    if (!gl) {
      return;
    }

    var str = task.detectVersionString();
    var ucode = kUCode_GBI0;

    //RSP Gfx ucode F3DEX.NoN fifo 2.08 Yoshitaka Yasumoto 1999 Nintendo

    // FIXME: lots of work here
    if (str.indexOf('F3DEX') >= 0 ||
      str.indexOf('F3DLP') >= 0 ||
      str.indexOf('F3DLX') >= 0) {
      ucode = kUCode_GBI1;

      if (str.indexOf('2.') >= 0) {
        ucode = kUCode_GBI2;
      }

    } else {
      var val = task.computeMicrocodeHash();
      switch (val) {
        case 0x00000000:
          ucode = kUCode_GBI0;
          logger.log('ucode is empty?');
          break;
        case 0xd73a12c4:
          ucode = kUCode_GBI0;
          break; // Fish demo
        case 0xf4c3491b:
          ucode = kUCode_GBI0;
          break; // Super Mario 64
        case 0x313f038b:
          ucode = kUCode_GBI0;
          break; // PilotWings
        case 0x64cc729d:
          ucode = kUCode_GBI0_WR;
          break; // Wave Race
        case 0x23f92542:
          ucode = kUCode_GBI0_GE;
          break; // Goldeneye
        default:
          hleHalt('Unknown GBI hash ' + toString32(val));
          break;
      }
    }

    if (str !== last_ucode_str) {
      logger.log('GFX: ' + graphics_task_count + ' - ' + str + ' = ucode ' + ucode);
    }
    last_ucode_str = str;

    var ram = n64js.getRamDataView();

    resetState(ucode, ram, task.data_ptr);
    var ucode_table = buildUCodeTables(ucode);

    // Render everything to the back buffer. This prevents horrible flickering
    // if due to webgl clearing our context between updates.
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);

    setViScales();

    var canvas = document.getElementById('display');
    setCanvasViewport(canvas.clientWidth, canvas.clientHeight);

    var pc, cmd0, cmd1;

    if (disassembler) {
      debugCurrentOp = 0;

      while (state.pc !== 0) {
        pc = state.pc;
        cmd0 = ram.getUint32(pc + 0);
        cmd1 = ram.getUint32(pc + 4);
        state.pc += 8;

        disassembler.begin(pc, cmd0, cmd1, state.dlistStack.length);
        ucode_table[cmd0 >>> 24](cmd0, cmd1, disassembler);
        disassembler.end();
        debugCurrentOp++;
      }
    } else {
      // Vanilla loop, no disassembler to worry about
      debugCurrentOp = 0;
      while (state.pc !== 0) {
        pc = state.pc;
        cmd0 = ram.getUint32(pc + 0);
        cmd1 = ram.getUint32(pc + 4);
        state.pc += 8;

        ucode_table[cmd0 >>> 24](cmd0, cmd1);

        if (bail_after > -1 && debugCurrentOp >= bail_after) {
          break;
        }
        debugCurrentOp++;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function resetState(ucode, ram, pc) {
    config.vertexStride = kUcodeStrides[ucode];

    ram_u8 = n64js.getRamU8Array();
    ram_s32 = n64js.getRamS32Array();
    ram_dv = ram; // FIXME: remove DataView
    state.rdpOtherModeL = 0x00500001;
    state.rdpOtherModeH = 0x00000000;

    state.projection = [Matrix.identity()];
    state.modelview = [Matrix.identity()];

    state.geometryModeBits = 0;
    state.geometryMode.zbuffer = 0;
    state.geometryMode.texture = 0;
    state.geometryMode.shade = 0;
    state.geometryMode.shadeSmooth = 0;
    state.geometryMode.cullFront = 0;
    state.geometryMode.cullBack = 0;
    state.geometryMode.fog = 0;
    state.geometryMode.lighting = 0;
    state.geometryMode.textureGen = 0;
    state.geometryMode.textureGenLinear = 0;
    state.geometryMode.lod = 0;

    state.pc = pc;
    state.dlistStack = [];
    for (let i = 0; i < state.segments.length; ++i) {
      state.segments[i] = 0;
    }

    for (let i = 0; i < state.tiles.length; ++i) {
      state.tiles[i] = new Tile();
    }

    state.numLights = 0;
    for (let i = 0; i < state.lights.length; ++i) {
      state.lights[i] = { color: { r: 0, g: 0, b: 0, a: 0 }, dir: Vector3.create([1, 0, 0]) };
    }

    for (let i = 0; i < state.projectedVertices.length; ++i) {
      state.projectedVertices[i] = new ProjectedVertex();
    }
  }

  function setScrubText(x, max) {
    $dlistScrub.find('.scrub-text').html('uCode op ' + x + '/' + max + '.');
  }

  function setScrubRange(max) {
    $dlistScrub.find('input').attr({
      min: 0,
      max: max,
      value: max
    });
    setScrubText(max, max);
  }

  function setScrubTime(t) {
    debugBailAfter = t;
    setScrubText(debugBailAfter, debugNumOps);

    var $instr = $dlistOutput.find('#I' + debugBailAfter);

    $dlistOutput.scrollTop($dlistOutput.scrollTop() + $instr.position().top -
      $dlistOutput.height() / 2 + $instr.height() / 2);

    $dlistOutput.find('.hle-instr').removeAttr('style');
    $instr.css('background-color', 'rgb(255,255,204)');
  }

  function initDebugUI() {
    var $dlistControls = $dlistContent.find('#controls');

    debugBailAfter = -1;
    debugNumOps = 0;

    $dlistControls.find('#rwd').click(function() {
      if (debugDisplayListRunning && debugBailAfter > 0) {
        setScrubTime(debugBailAfter - 1);
      }
    });
    $dlistControls.find('#fwd').click(function() {
      if (debugDisplayListRunning && debugBailAfter < debugNumOps) {
        setScrubTime(debugBailAfter + 1);
      }
    });
    $dlistControls.find('#stop').click(function() {
      n64js.toggleDebugDisplayList();
    });

    $dlistScrub = $dlistControls.find('.scrub');
    $dlistScrub.find('input').change(function() {
      setScrubTime($(this).val() | 0);
    });
    setScrubRange(0);

    $dlistState = $dlistContent.find('.hle-state');

    $dlistOutput = $('<div class="hle-disasm"></div>');
    $('#adjacent-debug').empty().append($dlistOutput);
  }

  //
  // Called when the canvas is created to get the ball rolling.
  // Figuratively, that is. There's nothing moving in this demo.
  //
  n64js.initialiseRenderer = function($canvas) {
    initDebugUI();

    var canvas = $canvas[0];
    initWebGL(canvas); // Initialize the GL context

    // Only continue if WebGL is available and working
    if (gl) {
      frameBufferTexture2D = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // We call texImage2D to initialise frameBufferTexture2D when it's used

      frameBuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
      frameBuffer.width = 640;
      frameBuffer.height = 480;

      frameBufferTexture3D = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, frameBufferTexture3D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, frameBuffer.width, frameBuffer.height, 0, gl.RGBA,
        gl.UNSIGNED_BYTE, null);

      var renderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, frameBuffer.width,
        frameBuffer.height);

      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
        frameBufferTexture3D, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER,
        renderbuffer);

      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Clear to black, fully opaque
      gl.clearColor(0.0, 0.0, 0.0, 1.0);

      // Clear everything
      gl.clearDepth(1.0);

      // Enable depth testing
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Near things obscure far things
      gl.depthFunc(gl.LEQUAL);

      fillShaderProgram = shaders.createShaderProgram(gl, "fill-shader-vs", "fill-shader-fs");
      fill_vertexPositionAttribute = gl.getAttribLocation(fillShaderProgram, "aVertexPosition");
      fill_uPMatrix = gl.getUniformLocation(fillShaderProgram, "uPMatrix");
      fill_uFillColor = gl.getUniformLocation(fillShaderProgram, "uFillColor");

      blitShaderProgram = shaders.createShaderProgram(gl, "blit-shader-vs", "blit-shader-fs");
      blit_vertexPositionAttribute = gl.getAttribLocation(blitShaderProgram, "aVertexPosition");
      blit_texCoordAttribute = gl.getAttribLocation(blitShaderProgram, "aTextureCoord");
      blit_uSampler = gl.getUniformLocation(blitShaderProgram, "uSampler");

      rectVerticesBuffer = gl.createBuffer();
      n64PositionsBuffer = gl.createBuffer();
      n64ColorsBuffer = gl.createBuffer();
      n64UVBuffer = gl.createBuffer();

      setCanvasViewport(canvas.clientWidth, canvas.clientHeight);
    }
  };

  n64js.resetRenderer = function() {
    textureCache = {};
    $textureOutput.html('');
    ram_u8 = n64js.getRamU8Array();
    ram_s32 = n64js.getRamS32Array();
    ram_dv = n64js.getRamDataView();
  };

  function getCurrentN64Shader(cycle_type, alpha_threshold) {
    var mux0 = state.combine.hi;
    var mux1 = state.combine.lo;

    return shaders.getOrCreateN64Shader(gl, mux0, mux1, cycle_type, alpha_threshold);
  }

  function hashTmem(tmem32, offset, len, hash) {
    let i = offset >> 2;
    let e = (offset + len) >> 2;
    while (i < e) {
      hash = ((hash * 17) + tmem32[i]) >>> 0;
      ++i;
    }
    return hash;
  }

  function calculateTmemCrc(tile) {
    if (tile.hash) {
      return tile.hash;
    }

    //var width = tile.width;
    var height = tile.height;

    var src = state.tmemData32;
    var tmem_offset = tile.tmem << 3;
    var bytes_per_line = tile.line << 3;

    // NB! RGBA/32 line needs to be doubled.
    if (tile.format == gbi.ImageFormat.G_IM_FMT_RGBA &&
      tile.size == gbi.ImageSize.G_IM_SIZ_32b) {
      bytes_per_line *= 2;
    }

    // TODO: not sure what happens when width != tile.line. Maybe we should hash rows separately?

    var len = height * bytes_per_line;

    var hash = hashTmem(src, tmem_offset, len, 0);

    // For palettised textures, check the palette entries too
    if (tile.format === gbi.ImageFormat.G_IM_FMT_CI ||
      tile.format === gbi.ImageFormat.G_IM_FMT_RGBA) { // NB RGBA check is for extreme-g, which specifies RGBA/4 and RGBA/8 instead of CI/4 and CI/8

      if (tile.size === gbi.ImageSize.G_IM_SIZ_8b) {
        hash = hashTmem(src, 0x100 << 3, 256 * 2, hash);
      } else if (tile.size === gbi.ImageSize.G_IM_SIZ_4b) {
        hash = hashTmem(src, (0x100 << 3) + (tile.palette * 16 * 2), 16 * 2, hash);
      }
    }

    tile.hash = hash;
    return hash;
  }

  /**
   * Looks up the texture defined at the specified tile index.
   * @param {number} tileIdx
   * @return {?Texture}
   */
  function lookupTexture(tileIdx) {
    var tile = state.tiles[tileIdx];
    var tmem_address = tile.tmem;

    // Skip empty tiles - this is primarily for the debug ui.
    if (tile.line === 0) {
      return null;
    }

    // FIXME: we can cache this if tile/tmem state hasn't changed since the last draw call.
    var hash = calculateTmemCrc(tile);

    // Check if the texture is already cached.
    // FIXME: we also need to check other properties (mirror, clamp etc), and recreate every frame (or when underlying data changes)
    var cache_id = toString32(hash) + tile.lrs + '-' + tile.lrt;

    var texture;
    if (textureCache.hasOwnProperty(cache_id)) {
      texture = textureCache[cache_id];
    } else {
      texture = decodeTexture(tile, getTextureLUTType());
      textureCache[cache_id] = texture;
    }

    return texture;
  }

  /**
   * Decodes the texture defined by the specified tile.
   * @param {!Tile} tile
   * @param {number} tlutFormat
   * @return {?Texture}
   */
  function decodeTexture(tile, tlutFormat) {
    var texture = new Texture(gl, tile.left, tile.top, tile.width, tile.height);
    if (!texture.$canvas[0].getContext) {
      return null;
    }

    $textureOutput.append(
      gbi.ImageFormat.nameOf(tile.format) + ', ' +
      gbi.ImageSize.nameOf(tile.size) + ',' +
      tile.width + 'x' + tile.height + ', ' +
      '<br>');

    var ctx = texture.$canvas[0].getContext('2d');
    var imgData = ctx.createImageData(texture.nativeWidth, texture.nativeHeight);

    var handled = convertTexels(imgData, state.tmemData, tile, tlutFormat);
    if (handled) {
      clampTexture(imgData, tile.width, tile.height);

      ctx.putImageData(imgData, 0, 0);

      $textureOutput.append(texture.$canvas);
      $textureOutput.append('<br>');
    } else {
      var msg = gbi.ImageFormat.nameOf(tile.format) + '/' +
          gbi.ImageSize.nameOf(tile.size) + ' is unhandled';
      $textureOutput.append(msg);
      // FIXME: fill with placeholder texture
      hleHalt(msg);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture.$canvas[0]);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);

    var clampS = tile.cm_s === gbi.G_TX_CLAMP || (tile.mask_s === 0);
    var clampT = tile.cm_t === gbi.G_TX_CLAMP || (tile.mask_t === 0);
    var mirrorS = tile.cm_s === gbi.G_TX_MIRROR;
    var mirrorT = tile.cm_t === gbi.G_TX_MIRROR;

    var mode_s = clampS ? gl.CLAMP_TO_EDGE : (mirrorS ? gl.MIRRORED_REPEAT : gl.REPEAT);
    var mode_t = clampT ? gl.CLAMP_TO_EDGE : (mirrorT ? gl.MIRRORED_REPEAT : gl.REPEAT);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode_s);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode_t);

    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }
}(window.n64js = window.n64js || {}));
