import io
import logging
from pypdf import PdfReader

logger = logging.getLogger(__name__)

def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract text from PDF raw bytes using pypdf."""
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        text_parts = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
        return "\n".join(text_parts).strip()
    except Exception as e:
        logger.exception("Failed to parse PDF bytes with pypdf")
        # Graceful fallback: see if we can decode any plain ASCII characters
        try:
            return pdf_bytes.decode("ascii", errors="ignore")[:2000]
        except Exception:
            return f"Error extracting text: {str(e)}"
