// ----- State dan helper DOM -----
const $ = (id) => document.getElementById(id);

function isOrthogonal(rotateDeg) {
  const rounded = Math.round(rotateDeg);
  return Math.abs(rotateDeg - rounded) < 1e-7 && rounded % 90 === 0;
}

let mainImage = null;
let watermarkImage = null;
let latestJobId = null;
let cropper = null;
window.isProcessingSVD = false;
const overlay = $("overlay");
const overlayCanvas = overlay.querySelector("canvas");

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

function syncRange(range, number) {
  range.addEventListener("input", () => (number.value = range.value));
  number.addEventListener("input", () => (range.value = number.value));
}
syncRange($("alpha"), $("alphaNumber"));
syncRange($("quality"), $("qualityNumber"));

// ----- Event input gambar dan teks -----
$("mainFile").addEventListener("change", async (event) => {
  if (!event.target.files[0]) return;
  mainImage = await fileToImage(event.target.files[0]);
  $("mainPreview").src = mainImage.src;
  $("empty").style.display = "none";
  $("mainPreview").onload = () => {
    resetOverlay();
    updateReady();
  };
});

$("watermarkFile").addEventListener("change", async (event) => {
  if (!event.target.files[0]) return;
  watermarkImage = await fileToImage(event.target.files[0]);
  $("watermarkText").value = "";
  drawOverlay();
  updateReady();
});

$("watermarkText").addEventListener("input", () => {
  if ($("watermarkText").value.trim()) watermarkImage = null;
  drawOverlay();
  updateReady();
});

// ----- Editor overlay: gambar/teks, drag, dan resize -----
function resetOverlay() {
  const image = $("mainPreview");
  const stage = $("stage");
  const width = Math.max(80, image.clientWidth * 0.28);
  overlay.style.width = width + "px";
  overlay.style.height = Math.max(48, width * 0.45) + "px";
  overlay.style.left = image.offsetLeft + image.clientWidth - width - 18 + "px";
  overlay.style.top =
    image.offsetTop +
    image.clientHeight -
    parseFloat(overlay.style.height) -
    18 +
    "px";
  drawOverlay();
}

function drawOverlay() {
  const text = $("watermarkText").value.trim();
  if (!mainImage || (!watermarkImage && !text)) {
    overlay.style.display = "none";
    return;
  }
  overlay.style.display = "block";
  const w = Math.max(1, Math.round(overlay.clientWidth));
  const h = Math.max(1, Math.round(overlay.clientHeight));
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (watermarkImage) {
    ctx.drawImage(watermarkImage, 0, 0, w, h);
  } else {
    drawTextWatermark(ctx, text, 0, 0, w, h);
  }
}

function drawTextWatermark(ctx, text, x, y, width, height) {
  ctx.save();
  ctx.fillStyle = "rgb(255,255,255)";
  ctx.font = `800 ${Math.max(13, Math.min(height * 0.55, width / Math.max(3, text.length * 0.58)))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + width / 2, y + height / 2);
  ctx.restore();
}

let drag = null;
overlay.addEventListener("pointerdown", (e) => {
  if (e.target.id === "resize") return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    left: overlay.offsetLeft,
    top: overlay.offsetTop,
  };
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener("pointermove", (e) => {
  if (!drag) return;
  moveOverlay(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
});
overlay.addEventListener("pointerup", () => (drag = null));

let resizing = null;
$("resize").addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  resizing = {
    x: e.clientX,
    y: e.clientY,
    w: overlay.clientWidth,
    h: overlay.clientHeight,
  };
  $("resize").setPointerCapture(e.pointerId);
});
$("resize").addEventListener("pointermove", (e) => {
  if (!resizing) return;
  overlay.style.width =
    Math.max(60, resizing.w + e.clientX - resizing.x) + "px";
  overlay.style.height =
    Math.max(35, resizing.h + e.clientY - resizing.y) + "px";
  drawOverlay();
});
$("resize").addEventListener("pointerup", () => (resizing = null));

function moveOverlay(left, top) {
  const image = $("mainPreview");
  const minX = image.offsetLeft,
    minY = image.offsetTop;
  const maxX = minX + image.clientWidth - overlay.clientWidth;
  const maxY = minY + image.clientHeight - overlay.clientHeight;
  overlay.style.left = Math.min(maxX, Math.max(minX, left)) + "px";
  overlay.style.top = Math.min(maxY, Math.max(minY, top)) + "px";
}

function updateReady() {
  if (window.isProcessingSVD) {
    $("run").disabled = true;
    return;
  }
  const ready =
    mainImage && (watermarkImage || $("watermarkText").value.trim());
  $("run").disabled = !ready;
  $("status").textContent = ready
    ? "Siap. Atur posisi lalu jalankan embedding."
    : "Pilih gambar utama dan watermark/teks.";
}

function lockSidebar() {
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) {
    sidebar.classList.add("sidebar-readonly");
    const inputs = sidebar.querySelectorAll("input, button");
    inputs.forEach((input) => {
      input.disabled = true;
    });
  }
}

function unlockSidebar() {
  // Only unlock if we are currently on the 'setup' tab and not processing
  const activeTab = document.querySelector(".tab.active");
  if (
    activeTab &&
    activeTab.dataset.tab === "setup" &&
    !window.isProcessingSVD
  ) {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) {
      sidebar.classList.remove("sidebar-readonly");
      const inputs = sidebar.querySelectorAll("input, button");
      inputs.forEach((input) => {
        if (input.id === "run") {
          updateReady();
        } else {
          input.disabled = false;
        }
      });
    }
  }
}

// ----- Canvas sumber pada resolusi asli -----
function imageCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

function buildWatermarkCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = mainImage.naturalWidth;
  canvas.height = mainImage.naturalHeight;
  const ctx = canvas.getContext("2d");
  const image = $("mainPreview");
  const scaleX = canvas.width / image.clientWidth,
    scaleY = canvas.height / image.clientHeight;
  const x = (overlay.offsetLeft - image.offsetLeft) * scaleX;
  const y = (overlay.offsetTop - image.offsetTop) * scaleY;
  const width = overlay.clientWidth * scaleX;
  const height = overlay.clientHeight * scaleY;
  const text = $("watermarkText").value.trim();
  if (watermarkImage) {
    ctx.drawImage(watermarkImage, x, y, width, height);
  } else {
    drawTextWatermark(ctx, text, x, y, width, height);
  }
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function updateViewerForImage(imgElement) {
  if (
    !imgElement ||
    imgElement.tagName.toLowerCase() !== "img" ||
    imgElement.id === "cropSource"
  )
    return;
  if (imgElement.viewer) {
    imgElement.viewer.update();
  } else {
    new Viewer(imgElement, {
      navbar: false,
      title: false,
      toolbar: {
        zoomIn: 1,
        zoomOut: 1,
        oneToOne: 1,
        reset: 1,
        rotateLeft: 1,
        rotateRight: 1,
        flipHorizontal: 1,
        flipVertical: 1,
      },
    });
  }
}

function dataUrlToCanvas(dataUrl, targetId) {
  return new Promise((resolve, reject) => {
    const target = $(targetId);
    if (target && target.tagName.toLowerCase() === "img") {
      target.onload = () => {
        if (typeof Viewer !== "undefined") {
          updateViewerForImage(target);
        }
        resolve();
      };
      target.onerror = reject;
      target.src = dataUrl;
    } else if (target) {
      const image = new Image();
      image.onload = () => {
        target.width = image.naturalWidth;
        target.height = image.naturalHeight;
        target.getContext("2d").drawImage(image, 0, 0);
        resolve();
      };
      image.onerror = reject;
      image.src = dataUrl;
    } else {
      resolve();
    }
  });
}

function dataUrlToImage(dataUrl, targetId) {
  return new Promise((resolve, reject) => {
    const image = $(targetId);
    image.onload = resolve;
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function copyCanvas(source, id) {
  const target = $(id);
  if (target) {
    if (target.tagName.toLowerCase() === "img") {
      target.onload = () => {
        if (typeof Viewer !== "undefined") {
          updateViewerForImage(target);
        }
      };
      target.src = source.toDataURL();
    } else {
      target.width = source.width;
      target.height = source.height;
      target.getContext("2d").drawImage(source, 0, 0);
    }
  }
}

function rotateCanvas(source, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * cosine + source.height * sine);
  canvas.height = Math.round(source.width * sine + source.height * cosine);
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function buildCropReconstructions(croppedCanvas, cropData) {
  const original = $("watermarked");
  const origW = original.naturalWidth || original.width;
  const origH = original.naturalHeight || original.height;
  const known = document.createElement("canvas");
  known.width = origW;
  known.height = origH;
  const unknown = document.createElement("canvas");
  unknown.width = origW;
  unknown.height = origH;

  const restored = rotateCanvas(croppedCanvas, -(cropData.rotate || 0));
  const rotatedQuarterTurn = Math.abs(cropData.rotate || 0) % 180 === 90;
  const coversOriginal =
    cropData.width >= origW - 1 && cropData.height >= origH - 1;
  const coversRotatedOriginal =
    rotatedQuarterTurn &&
    cropData.width >= origH - 1 &&
    cropData.height >= origW - 1;

  if (coversOriginal || coversRotatedOriginal) {
    known.getContext("2d").drawImage(restored, 0, 0, origW, origH);
  } else {
    known
      .getContext("2d")
      .drawImage(
        restored,
        Math.round(cropData.x),
        Math.round(cropData.y),
        Math.round(cropData.width),
        Math.round(cropData.height),
      );
  }
  unknown.getContext("2d").drawImage(croppedCanvas, 0, 0);
  return { known, unknown };
}

let lastCropperImageSrc = null;
let constraining = false;

function constrainCropBox(instance) {
  const activeCropper =
    instance && typeof instance.getImageData === "function"
      ? instance
      : instance && instance.cropper
        ? instance.cropper
        : cropper;
  if (!activeCropper || constraining) return;

  const imageData = activeCropper.getImageData();
  const canvasData = activeCropper.getCanvasData();
  const cropBoxData = activeCropper.getCropBoxData();

  if (!imageData || !canvasData || !cropBoxData) return;

  const rotateDeg = imageData.rotate || 0;
  if (isOrthogonal(rotateDeg)) return;

  const W = imageData.width;
  const H = imageData.height;
  const xc = canvasData.left + canvasData.width / 2;
  const yc = canvasData.top + canvasData.height / 2;

  const rotateRad = (rotateDeg * Math.PI) / 180;
  const cosT = Math.abs(Math.cos(rotateRad));
  const sinT = Math.abs(Math.sin(rotateRad));

  let width = cropBoxData.width;
  let height = cropBoxData.height;
  let left = cropBoxData.left;
  let top = cropBoxData.top;
  let changed = false;

  // 1. Clamp width and height to maximum possible dimensions for the rotated image
  const minSize = 20;

  let maxW = Infinity;
  if (sinT > 1e-5) maxW = Math.min(maxW, (H - minSize * cosT) / sinT);
  if (cosT > 1e-5) maxW = Math.min(maxW, (W - minSize * sinT) / cosT);
  maxW = Math.max(
    minSize,
    Math.min(maxW, sinT > 1e-5 ? H / sinT : W, cosT > 1e-5 ? W / cosT : W),
  );

  if (width > maxW) {
    width = maxW;
    changed = true;
  }
  if (width < minSize) {
    width = minSize;
    changed = true;
  }

  let maxH = Infinity;
  if (cosT > 1e-5) maxH = Math.min(maxH, (H - width * sinT) / cosT);
  if (sinT > 1e-5) maxH = Math.min(maxH, (W - width * cosT) / sinT);
  maxH = Math.max(
    minSize,
    Math.min(maxH, cosT > 1e-5 ? H / cosT : H, sinT > 1e-5 ? W / sinT : H),
  );

  if (height > maxH) {
    height = maxH;
    changed = true;
  }
  if (height < minSize) {
    height = minSize;
    changed = true;
  }

  // 2. Position constraints (in image local coordinates)
  const U_max = Math.max(0, (W - (width * cosT + height * sinT)) / 2);
  const V_max = Math.max(0, (H - (width * sinT + height * cosT)) / 2);

  const x_cb = left + width / 2;
  const y_cb = top + height / 2;

  const dx = x_cb - xc;
  const dy = y_cb - yc;

  const cosR = Math.cos(rotateRad);
  const sinR = Math.sin(rotateRad);
  const U = dx * cosR + dy * sinR;
  const V = -dx * sinR + dy * cosR;

  const uClamped = Math.max(-U_max, Math.min(U_max, U));
  const vClamped = Math.max(-V_max, Math.min(V_max, V));

  if (Math.abs(uClamped - U) > 1e-2 || Math.abs(vClamped - V) > 1e-2) {
    changed = true;
  }

  if (changed) {
    const dxNew = uClamped * cosR - vClamped * sinR;
    const dyNew = uClamped * sinR + vClamped * cosR;
    left = xc + dxNew - width / 2;
    top = yc + dyNew - height / 2;

    constraining = true;
    activeCropper.setCropBoxData({ left, top, width, height });
    constraining = false;
  }
}

function fitImageToContainer() {
  if (!cropper) return;
  const imageData = cropper.getImageData();
  const containerData = cropper.getContainerData();
  if (imageData && containerData) {
    const W0 = imageData.naturalWidth;
    const H0 = imageData.naturalHeight;
    const Wc = containerData.width;
    const Hc = containerData.height;
    const rotateRad = ((imageData.rotate || 0) * Math.PI) / 180;
    const cosT = Math.abs(Math.cos(rotateRad));
    const sinT = Math.abs(Math.sin(rotateRad));

    const W_rot = W0 * cosT + H0 * sinT;
    const H_rot = W0 * sinT + H0 * cosT;

    // We add a 2% margin so the image doesn't touch the very edges of the container
    const margin = 0.98;
    const s_fit = Math.min((Wc * margin) / W_rot, (Hc * margin) / H_rot);

    cropper.zoomTo(s_fit);
  }
}

function adjustCropBoxToMaxFit() {
  if (!cropper) return;
  const imageData = cropper.getImageData();
  if (imageData) {
    cropper.setData({
      x: 0,
      y: 0,
      width: imageData.naturalWidth,
      height: imageData.naturalHeight,
    });
  }
}

function initializeCropEditor() {
  const image = $("cropSource");
  if (
    !image.src ||
    image.src.endsWith("/") ||
    image.src === window.location.href
  ) {
    return;
  }

  // If cropper already exists and source is the same, simply resize it to fit
  if (cropper && lastCropperImageSrc === image.src) {
    cropper.resize();
    return;
  }

  cropper?.destroy();
  cropper = null; // Prevent race conditions referencing destroyed instances
  lastCropperImageSrc = image.src;

  cropper = new Cropper(image, {
    viewMode: 1, // Restrict crop box to canvas bounds
    dragMode: "move",
    autoCropArea: 0.8,
    responsive: true,
    background: false,
    rotatable: true,
    zoomable: true,
    movable: true,
    ready() {
      fitImageToContainer();
      adjustCropBoxToMaxFit();
    },
    crop(event) {
      constrainCropBox(this);
    },
    zoom(event) {
      // Prevent zoom-out from blocking: proportionally shrink crop box
      const activeCropper = this.cropper || cropper;
      if (!activeCropper) return;
      const nextRatio = event.detail.ratio;
      const oldRatio = event.detail.oldRatio;
      if (nextRatio < oldRatio) {
        const scale = nextRatio / oldRatio;
        const cropBoxData = activeCropper.getCropBoxData();
        const canvasData = activeCropper.getCanvasData();
        if (cropBoxData && canvasData) {
          activeCropper.setCropBoxData({
            width: cropBoxData.width * scale,
            height: cropBoxData.height * scale,
            left: cropBoxData.left + (cropBoxData.width * (1 - scale)) / 2,
            top: cropBoxData.top + (cropBoxData.height * (1 - scale)) / 2,
          });
        }
      }
    },
  });
  $("runCrop").disabled = false;
  $("cropStatus").textContent =
    "Crop simulated attack: drag the crop window, rotate or zoom, then run test.";
}

document.querySelectorAll("[data-crop-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!cropper) return;
    const action = button.dataset.cropAction;
    if (action === "rotate-left" || action === "rotate-right") {
      const canvasData = cropper.getCanvasData();
      if (canvasData) {
        cropper.setCropBoxData({
          width: 20,
          height: 20,
          left: canvasData.left + canvasData.width / 2 - 10,
          top: canvasData.top + canvasData.height / 2 - 10,
        });
      }
      if (action === "rotate-left") cropper.rotate(-90);
      else cropper.rotate(90);
      fitImageToContainer();
      adjustCropBoxToMaxFit();
    }
    if (action === "zoom-in") cropper.zoom(0.1);
    if (action === "zoom-out") {
      const cropBoxData = cropper.getCropBoxData();
      if (cropBoxData) {
        const scale = 0.9;
        cropper.setCropBoxData({
          width: cropBoxData.width * scale,
          height: cropBoxData.height * scale,
          left: cropBoxData.left + (cropBoxData.width * (1 - scale)) / 2,
          top: cropBoxData.top + (cropBoxData.height * (1 - scale)) / 2,
        });
      }
      cropper.zoom(-0.1);
    }
    if (action === "select-all") {
      adjustCropBoxToMaxFit();
    }
    if (action === "reset") {
      cropper.reset();
      fitImageToContainer();
      adjustCropBoxToMaxFit();
      const slider = $("cropRotateSlider");
      const val = $("cropRotateValue");
      if (slider && val) {
        slider.value = 0;
        val.textContent = "0°";
      }
      setTimeout(constrainCropBox, 50);
    }
  });
});

// Capture wheel events on the crop container to shrink the crop box before Cropper.js blocks zoom-out
const cropEditorContainer = document.querySelector(".crop-editor-container");
if (cropEditorContainer) {
  cropEditorContainer.addEventListener(
    "wheel",
    (e) => {
      if (!cropper) return;
      // e.deltaY > 0 means zoom-out
      if (e.deltaY > 0) {
        const cropBoxData = cropper.getCropBoxData();
        if (cropBoxData) {
          const scale = 0.95;
          cropper.setCropBoxData({
            width: cropBoxData.width * scale,
            height: cropBoxData.height * scale,
            left: cropBoxData.left + (cropBoxData.width * (1 - scale)) / 2,
            top: cropBoxData.top + (cropBoxData.height * (1 - scale)) / 2,
          });
        }
      }
    },
    { capture: true, passive: true },
  );
}

async function setProgress(value, message) {
  $("progress").value = value;
  $("status").textContent = message;
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// ----- Orchestration: kirim input dan tampilkan respons server -----
$("run").addEventListener("click", async () => {
  // Clean up cropper state immediately before starting process to prevent bound image mutations
  if (cropper) {
    cropper.destroy();
    cropper = null;
  }
  lastCropperImageSrc = null;
  const cropSrcImg = $("cropSource");
  if (cropSrcImg) {
    cropSrcImg.src = "";
  }
  $("runCrop").disabled = true;
  $("cropStatus").textContent = "Executing SVD embedding...";

  window.isProcessingSVD = true;
  lockSidebar();
  $("progress").value = 0;
  try {
    await setProgress(5, "Membentuk citra resolusi asli...");
    const originalCanvas = imageCanvas(mainImage);
    const watermarkCanvas = buildWatermarkCanvas();
    copyCanvas(originalCanvas, "original");
    copyCanvas(watermarkCanvas, "watermark");

    const form = new FormData();
    form.append("original", await canvasToBlob(originalCanvas), "original.png");
    form.append(
      "watermark",
      await canvasToBlob(watermarkCanvas),
      "watermark.png",
    );
    form.append("alpha", $("alphaNumber").value);
    form.append("jpeg_quality", $("qualityNumber").value);

    await setProgress(
      20,
      "Mengirim gambar ke server. Server sedang menghitung SVD...",
    );
    $("progress").removeAttribute("value");
    const response = await fetch("/api/embed-image", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.detail || "Server gagal memproses gambar.");

    $("progress").value = 85;
    await setProgress(85, "Menampilkan hasil kalkulasi server...");
    await Promise.all([
      dataUrlToCanvas(result.images.watermarked, "watermarked"),
      dataUrlToImage(result.images.watermarked, "cropSource"),
      dataUrlToCanvas(result.images.compressed, "compressed"),
      dataUrlToCanvas(result.images.extracted_ideal, "extractedIdeal"),
      dataUrlToCanvas(result.images.extracted, "extracted"),
    ]);
    latestJobId = result.id;
    $("runCrop").disabled = false;

    const activeTab = document.querySelector(".tab.active");
    if (activeTab && activeTab.dataset.tab === "robustness") {
      initializeCropEditor();
    }

    $("corr").textContent =
      result.metrics.correlation_original_watermarked.toFixed(5);
    const ncVal = result.metrics.correlation_watermark_extracted;
    $("wcorr").textContent = ncVal.toFixed(5);
    await setProgress(
      100,
      `Selesai. Server memproses matriks RGB ${result.matrix_shape[0]} × ${result.matrix_shape[1]} dengan ${result.device.toUpperCase()}.`,
    );
  } catch (error) {
    console.error(error);
    $("progress").value = 0;
    $("status").textContent = "Gagal: " + error.message;
  } finally {
    window.isProcessingSVD = false;
    unlockSidebar();
  }
});

$("runCrop").addEventListener("click", async () => {
  if (!latestJobId || !cropper) return;
  const button = $("runCrop");
  button.disabled = true;
  $("cropStatus").textContent =
    "Server membuat crop nyata dan membandingkan extraction...";
  try {
    const original = $("watermarked");
    const origW = original.naturalWidth || original.width;
    const origH = original.naturalHeight || original.height;

    let cropData = cropper.getData(true);
    let croppedCanvas;

    const cropBoxData = cropper.getCropBoxData();
    const canvasData = cropper.getCanvasData();
    const isOrthogonalRot = isOrthogonal(cropData.rotate || 0);

    const isFullCrop =
      isOrthogonalRot &&
      cropBoxData &&
      canvasData &&
      Math.abs(cropBoxData.width - canvasData.width) < 2.0 &&
      Math.abs(cropBoxData.height - canvasData.height) < 2.0;

    if (isFullCrop) {
      cropData.x = 0;
      cropData.y = 0;
      cropData.width = origW;
      cropData.height = origH;
      croppedCanvas = rotateCanvas(original, cropData.rotate || 0);
    } else {
      croppedCanvas = cropper.getCroppedCanvas({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
      });
    }
    const reconstructions = buildCropReconstructions(croppedCanvas, cropData);
    const form = new FormData();
    form.append("id", latestJobId);
    form.append("cropped", await canvasToBlob(croppedCanvas), "cropped.png");
    form.append(
      "known_reconstruction",
      await canvasToBlob(reconstructions.known),
      "known-reconstruction.png",
    );
    form.append(
      "unknown_reconstruction",
      await canvasToBlob(reconstructions.unknown),
      "unknown-reconstruction.png",
    );
    form.append("x", Math.round(cropData.x));
    form.append("y", Math.round(cropData.y));
    form.append("source_width", Math.max(1, Math.round(cropData.width)));
    form.append("source_height", Math.max(1, Math.round(cropData.height)));
    form.append("rotation", cropData.rotate || 0);
    const response = await fetch("/api/crop-image", {
      method: "POST",
      body: form,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.detail || "Server gagal memproses crop.");

    await Promise.all([
      dataUrlToCanvas(result.images.cropped, "realCropped"),
      dataUrlToCanvas(
        result.images.known_position_reconstruction,
        "knownPositionReconstruction",
      ),
      dataUrlToCanvas(
        result.images.known_position_extracted,
        "knownPositionExtracted",
      ),
      dataUrlToCanvas(
        result.images.unknown_position_reconstruction,
        "unknownPositionReconstruction",
      ),
      dataUrlToCanvas(
        result.images.unknown_position_extracted,
        "unknownPositionExtracted",
      ),
    ]);
    const knownNc = result.metrics.known_position_correlation;
    $("knownCropCorr").textContent = knownNc.toFixed(5);
    const unknownNc = result.metrics.unknown_position_correlation;
    $("unknownCropCorr").textContent = unknownNc.toFixed(5);
    $("cropStatus").textContent =
      `Crop output ${result.crop.width} × ${result.crop.height}; area sumber ${result.crop.source_width} × ${result.crop.source_height} pada (${result.crop.x}, ${result.crop.y}); rotasi ${result.crop.rotation}°; dimensi asli ${result.original_size.width} × ${result.original_size.height}.`;
  } catch (error) {
    console.error(error);
    $("cropStatus").textContent = "Gagal: " + error.message;
  } finally {
    button.disabled = false;
  }
});
