import io


def test_rasterize_docx_media_tiff_to_png():
    from PIL import Image

    from opalatex.ide_server import _rasterize_docx_media_to_png

    source = io.BytesIO()
    Image.new("RGB", (2, 1), (255, 0, 0)).save(source, format="TIFF")

    result = _rasterize_docx_media_to_png(source.getvalue(), "image/tiff", "image1.tiff")

    assert result.startswith(b"\x89PNG\r\n\x1a\n")
    with Image.open(io.BytesIO(result)) as rendered:
        assert rendered.size == (2, 1)
        assert rendered.format == "PNG"
