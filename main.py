from __future__ import annotations

import io
import uuid
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

# ===== Constants ===== #
STATIC_PATH = Path(__file__).resolve().parent / "static"
DATA_PATH = Path(__file__).resolve().parent / "data"
DATA_PATH.mkdir(parents=True, exist_ok=True)  # Ensure directory exist


# ===== Global Variables ===== #
app = FastAPI(title="SVD Watermarking Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==== SVD Embedding, Extraction & Helper ==== #
def svd(matrix: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Melakukan operasi SVD pada matriks yang diberikan
    """

    u, s, vt = torch.linalg.svd(matrix, full_matrices=False)

    # S hasil svd dari fungsi diatas masih dalam bentuk vektor, akan kita ubah menjadi matriks diagonal
    return u, torch.diag(s), vt


def embed_watermark(
    data_matrix: torch.Tensor,
    watermark_matrix: torch.Tensor,
    alpha: float,
) -> tuple[torch.Tensor, dict[str, torch.Tensor | float]]:
    """Melakukan embedding watermark menggunakan modifikasi algoritma Jain

    Args:
        data_matrix (torch.Tensor): Matriks dari data asli
        watermark_matrix (torch.Tensor): Matriks dari data watermark
        alpha (float): Tingkat intensitas embedding. Semakin tinggi nilai alpha, watermark semakin kuat tetapi semakin terlihat

    Returns:
        tuple[torch.Tensor, dict[str, torch.Tensor | float]]: Tuple0 merupakan matriks hasil embedding data + watermark, Tuple1 merupakan key yang dihasilkan dari embedding watermark
    """

    # Step 1: Mencari V^T dari SVD data matriks data
    _, _, Vt = svd(data_matrix)

    # Step 2: Mencari Uw, Sw, dan Vw^T dari matriks watermax
    Uw, Sw, Vw_t = svd(watermark_matrix)

    # Step 3: Lakukan kalkulasi sesuai dengan algoritma Modified Jain untuk embedding
    # Aw = A + alpha * Uw * Sw * V^T
    Aw = data_matrix + alpha * Uw @ Sw @ Vt

    # Step 4: Simpan key utama hasil watermarking
    Key = {
        "original": data_matrix,
        "data_v": Vt.T,
        "watermark_vt": Vw_t,
        "alpha": alpha,
    }

    # Step 5: Return watermarked matriks dan key
    return Aw, Key


def extract_watermark(
    watermarked_matrix: torch.Tensor,
    key: dict[str, torch.Tensor | float],
) -> torch.Tensor:
    """Melakukan watermark extraction menggunakan modifikasi algoritma Jain

    Args:
        watermarked_matrix (torch.Tensor): Matriks dari data yang sudah diembed dengan watermark
        key (dict[str, torch.Tensor  |  float]): Key hasil embedding

    Returns:
        torch.Tensor: Matriks yang berisi data ekstraksi watermark
    """

    A_distorted = watermarked_matrix
    A = key["original"]
    V = key["data_v"]
    Vw_t = key["watermark_vt"]
    alpha = key["alpha"]

    # Lakukan kalkulasi sesuai dengan algoritma Modified Jain untuk extraction
    # W_disrtorted = ((A_distorted - A) * V * Vw) / alpha
    W_disrtorted = ((A_distorted - A) @ V @ Vw_t) / alpha

    return W_disrtorted


def corr(a: torch.Tensor, b: torch.Tensor) -> float:
    """Menghitung korelasi antara 2 matriks

    Args:
        a (torch.Tensor): Matriks A
        b (torch.Tensor): Matriks B

    Returns:
        float: Tingkat korelasi
    """

    # Frobenius norm pada matriks setara dengan vector norm setelah seluruh
    # elemen matriks dipandang sebagai satu vektor panjang.
    denominator = torch.linalg.vector_norm(a) * torch.linalg.vector_norm(b)
    if denominator.item() == 0:
        return 0.0

    # Step 2: Hitung Frobenius inner product, yaitu jumlah perkalian elemen yang bersesuaian.
    corr = torch.vdot(a.flatten(), b.flatten()).div(denominator).item()

    return corr


# ==== Image Utilities ==== #
def torch_device() -> torch.Device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def image_to_color_matrix(image: Image.Image) -> torch.Tensor:
    """Melakukan konversi gambar menjadi representasi matriks yang mengandung warna

    Args:
        image (Image.Image): _description_

    Returns:
        torch.Tensor: _description_
    """

    # Berdasarkan pada referensi jurnal section 1.2: Image processing
    # Gambar berwarna m x n x 3 direpresentasikan sebagai matriks 3m x n dengan menumpuk channel warna.

    rgb = np.asarray(image.convert("RGB"), dtype=np.float64).copy()
    tensor = torch.from_numpy(rgb).to(device=torch_device(), dtype=torch.float64)
    red, green, blue = tensor.unbind(dim=2)

    return torch.cat((red, green, blue), dim=0)


def color_matrix_to_image(matrix: torch.Tensor, normalize: bool = False) -> Image.Image:
    if normalize:
        # KEPUTUSAN DEMO:
        # Normalisasi min-max hanya untuk membuat matriks hasil extraction
        # terlihat sebagai gambar. Langkah ini bukan bagian algoritma paper.
        minimum = matrix.min()
        maximum = matrix.max()
        matrix = (matrix - minimum) * 255 / torch.clamp(maximum - minimum, min=1e-9)

    # KEBALIKAN REPRESENTASI SECTION 1.2:
    # Matriks 3m x n dipisah kembali menjadi kanal R, G, dan B.
    red, green, blue = torch.tensor_split(matrix, 3, dim=0)
    rgb = torch.stack((red, green, blue), dim=2)

    # KEPUTUSAN DEMO:
    # Pillow membutuhkan nilai piksel uint8 dalam rentang 0..255.
    # Clamping ini bukan bagian rumus watermarking paper.
    array = rgb.clamp(0, 255).to(dtype=torch.uint8).cpu().numpy()
    return Image.fromarray(array, "RGB")


def jpeg_compress(image: Image.Image, quality: float) -> Image.Image:
    """Melakukan compression terhadap gambar menggunakan JPEG

    Args:
        image (Image.Image): Gambar
        quality (float): Kualitas gambar

    Returns:
        Image.Image: Gambar setelah compression
    """

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=round(quality * 100))
    output.seek(0)
    return Image.open(output).convert("RGB")


async def read_image(file: UploadFile) -> Image.Image:
    """Membaca image dari file yang diunggah

    Args:
        file (UploadFile): File yang diunggah

    Returns:
        Image.Image: Gambar
    """
    try:
        return Image.open(io.BytesIO(await file.read())).convert("RGB")
    except Exception as error:
        raise HTTPException(
            status_code=400, detail=f"File gambar tidak valid: {error}"
        ) from error


def save_image(image: Image.Image, path: Path, file_name: str):
    image.save(path / file_name)


# ==== Misc Utilities ==== #
def save_extraction_key(
    key: dict[str, torch.Tensor | float],
    watermark_matrix: torch.Tensor,
) -> dict[str, object]:
    payload = {
        "original": key["original"].detach().cpu(),
        "data_v": key["data_v"].detach().cpu(),
        "watermark_vt": key["watermark_vt"].detach().cpu(),
        "watermark": watermark_matrix.detach().cpu(),
        "alpha": key["alpha"],
    }
    return payload


def load_extraction_key(
    path: Path,
) -> tuple[dict[str, torch.Tensor | float], torch.Tensor]:
    try:
        device = torch_device()
        payload = torch.load(path / "key.pt", map_location=device, weights_only=True)
        key = {
            "original": payload["original"].to(device),
            "data_v": payload["data_v"].to(device),
            "watermark_vt": payload["watermark_vt"].to(device),
            "alpha": float(payload["alpha"]),
        }
        watermark_matrix = payload["watermark"].to(torch_device())
        return key, watermark_matrix
    except Exception as error:
        raise HTTPException(
            status_code=500, detail="Extraction key artifact tidak valid."
        ) from error


# ===== HTTP Handlers ===== #
app.mount("/static", StaticFiles(directory=STATIC_PATH), name="static")


@app.get("/artifacts/{id}/{filename}")
def get_artifact(id: str, filename: str) -> FileResponse:
    artifact_path = DATA_PATH / id / filename
    if not artifact_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact tidak ditemukan.")
    return FileResponse(artifact_path)


@app.get("/")
def index_handler() -> FileResponse:
    return FileResponse(STATIC_PATH / "index.html")


@app.post("/api/embed-image")
async def embed_image_handler(
    original: UploadFile = File(...),
    watermark: UploadFile = File(...),
    alpha: float = Form(..., gt=0),
    jpeg_quality: float = Form(..., gt=0, le=1),
) -> dict[str, object]:
    """_summary_

    Args:
        original (UploadFile, optional): _description_. Defaults to File(...).
        watermark (UploadFile, optional): _description_. Defaults to File(...).
        alpha (float, optional): _description_. Defaults to Form(..., gt=0).
        jpeg_quality (float, optional): _description_. Defaults to Form(..., gt=0, le=1).

    Returns:
        dict[str, object]: _description_
    """
    original_image = await read_image(original)
    watermark_image = await read_image(watermark)

    # Dimensi gambar harus sama untuk kalkulasi matrix
    if original_image.size != watermark_image.size:
        raise HTTPException(
            status_code=400, detail="Dimensi original dan matriks watermark harus sama."
        )

    # Step 1: Konversi image menjadi matriks
    original_matrix = image_to_color_matrix(original_image)
    watermark_matrix = image_to_color_matrix(watermark_image)

    # Step 2: Lakukan embedding watermark ke original image
    watermarked_matrix, key = embed_watermark(original_matrix, watermark_matrix, alpha)

    # Step 3: Konversi matrix gambar yang telah diembed watermark menjadi image
    watermarked_image = color_matrix_to_image(watermarked_matrix)

    # Step 4: Lakukan watermark extraction pada hasil murni matriks setelah embedding (tidak melakukan processing apapun)
    extracted_matrix = extract_watermark(watermarked_matrix, key)
    extracted_image = color_matrix_to_image(extracted_matrix, normalize=True)

    # Step 5: Uji distortion pada watermarked image, kemudian extract kembali watermarknya
    compressed_watermarked_image = jpeg_compress(watermarked_image, jpeg_quality)
    compressed_watermarked_matrix = image_to_color_matrix(compressed_watermarked_image)
    extracted_compressed_matrix = extract_watermark(compressed_watermarked_matrix, key)
    extracted_compressed_image = color_matrix_to_image(
        extracted_compressed_matrix, normalize=True
    )

    # Step 6: Simpan data-data relevan ke disk
    id = uuid.uuid4().hex
    out_folder = DATA_PATH / id
    out_folder.mkdir(parents=True, exist_ok=True)

    # Simpan gambar hasil
    save_image(original_image, out_folder, "original.png")
    save_image(watermark_image, out_folder, "watermark.png")
    save_image(watermarked_image, out_folder, "watermarked.png")
    save_image(compressed_watermarked_image, out_folder, "compressed.jpg")
    save_image(extracted_image, out_folder, "extracted-ideal.png")
    save_image(extracted_compressed_image, out_folder, "extracted-jpeg.png")

    # Simpan embedding key
    torch.save(save_extraction_key(key, watermark_matrix), out_folder / "key.pt")

    return {
        "id": id,
        "images": {
            "watermarked": f"/artifacts/{id}/watermarked.png",
            "compressed": f"/artifacts/{id}/compressed.jpg",
            "extracted_ideal": f"/artifacts/{id}/extracted-ideal.png",
            "extracted": f"/artifacts/{id}/extracted-jpeg.png",
        },
        "metrics": {
            "correlation_original_watermarked": corr(
                original_matrix, watermarked_matrix
            ),
            "correlation_watermark_extracted": corr(
                watermark_matrix, extracted_compressed_matrix
            ),
        },
        "matrix_shape": list(original_matrix.shape),
    }


@app.post("/api/crop-image")
async def crop_image_handler(
    id: str = Form(...),
    cropped: UploadFile = File(...),
    known_reconstruction: UploadFile = File(...),
    unknown_reconstruction: UploadFile = File(...),
    x: int = Form(...),
    y: int = Form(...),
    source_width: int = Form(..., gt=0),
    source_height: int = Form(..., gt=0),
    rotation: float = Form(0),
):
    cropped_image = await read_image(cropped)
    known_position_image = await read_image(known_reconstruction)
    unknown_position_image = await read_image(unknown_reconstruction)
    output_dir = DATA_PATH / id

    if not output_dir.exists():
        raise HTTPException(status_code=404, detail=f"ID '{id}' tidak terdaftar")

    key, watermark_matrix = load_extraction_key(output_dir)

    expected_height = key["original"].shape[0] // 3
    expected_width = key["original"].shape[1]
    original_width, original_height = expected_width, expected_height

    if x >= original_width or y >= original_height:
        raise HTTPException(status_code=400, detail="Area crop berada di luar gambar.")

    if known_position_image.size != (original_width, original_height):
        raise HTTPException(
            status_code=400,
            detail="Rekonstruksi posisi diketahui harus berdimensi sama dengan original.",
        )

    if unknown_position_image.size != (original_width, original_height):
        raise HTTPException(
            status_code=400,
            detail="Rekonstruksi posisi tidak diketahui harus berdimensi sama dengan original.",
        )

    known_matrix = image_to_color_matrix(known_position_image)
    unknown_matrix = image_to_color_matrix(unknown_position_image)
    known_extracted = extract_watermark(known_matrix, key)
    unknown_extracted = extract_watermark(unknown_matrix, key)
    known_extracted_image = color_matrix_to_image(known_extracted, normalize=True)
    unknown_extracted_image = color_matrix_to_image(unknown_extracted, normalize=True)

    save_image(cropped_image, output_dir, "crop.png")
    save_image(known_position_image, output_dir, "crop-known-reconstruction.png")
    save_image(known_extracted_image, output_dir, "crop-known-extracted.png")
    save_image(unknown_position_image, output_dir, "crop-unknown-reconstruction.png")
    save_image(unknown_extracted_image, output_dir, "crop-unknown-extracted.png")

    cache_version = uuid.uuid4().hex

    return {
        "id": id,
        "images": {
            "cropped": f"/artifacts/{id}/crop.png?v={cache_version}",
            "known_position_reconstruction": f"/artifacts/{id}/crop-known-reconstruction.png?v={cache_version}",
            "known_position_extracted": f"/artifacts/{id}/crop-known-extracted.png?v={cache_version}",
            "unknown_position_reconstruction": f"/artifacts/{id}/crop-unknown-reconstruction.png?v={cache_version}",
            "unknown_position_extracted": f"/artifacts/{id}/crop-unknown-extracted.png?v={cache_version}",
        },
        "metrics": {
            "known_position_correlation": corr(watermark_matrix, known_extracted),
            "unknown_position_correlation": corr(watermark_matrix, unknown_extracted),
        },
        "crop": {
            "x": x,
            "y": y,
            "width": cropped_image.width,
            "height": cropped_image.height,
            "rotation": rotation,
            "source_width": source_width,
            "source_height": source_height,
        },
        "original_size": {"width": original_width, "height": original_height},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
