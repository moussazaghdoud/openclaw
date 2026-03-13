"""Presidio PII anonymization microservice."""

from fastapi import FastAPI
from pydantic import BaseModel
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

app = FastAPI(title="Presidio PII Service")

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

ENTITY_TYPES = [
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD",
    "IBAN_CODE", "IP_ADDRESS", "LOCATION", "DATE_TIME",
]


class AnonymizeRequest(BaseModel):
    text: str


class AnonymizeResponse(BaseModel):
    anonymized_text: str
    mapping: dict[str, str]


class DeanonymizeRequest(BaseModel):
    text: str
    mapping: dict[str, str]


class DeanonymizeResponse(BaseModel):
    text: str


@app.post("/anonymize", response_model=AnonymizeResponse)
def anonymize(req: AnonymizeRequest):
    results = analyzer.analyze(
        text=req.text,
        entities=ENTITY_TYPES,
        language="en",
    )

    # Sort by start position so we process left-to-right
    results = sorted(results, key=lambda r: r.start)

    # Build numbered placeholders per entity type
    counters: dict[str, int] = {}
    mapping: dict[str, str] = {}
    # Map each result to its placeholder
    placeholder_map: list[tuple] = []  # (start, end, placeholder)

    for r in results:
        original = req.text[r.start:r.end]
        # Check if this exact original value already has a placeholder
        existing = None
        for ph, orig in mapping.items():
            if orig == original:
                existing = ph
                break
        if existing:
            placeholder_map.append((r.start, r.end, existing))
        else:
            etype = r.entity_type
            counters[etype] = counters.get(etype, 0) + 1
            placeholder = f"<{etype}_{counters[etype]}>"
            mapping[placeholder] = original
            placeholder_map.append((r.start, r.end, placeholder))

    # Build anonymized text by replacing from end to start (to preserve offsets)
    anonymized = req.text
    for start, end, placeholder in reversed(placeholder_map):
        anonymized = anonymized[:start] + placeholder + anonymized[end:]

    return AnonymizeResponse(anonymized_text=anonymized, mapping=mapping)


@app.post("/deanonymize", response_model=DeanonymizeResponse)
def deanonymize(req: DeanonymizeRequest):
    text = req.text
    # Replace longest placeholders first to avoid partial matches
    for placeholder in sorted(req.mapping.keys(), key=len, reverse=True):
        text = text.replace(placeholder, req.mapping[placeholder])
    return DeanonymizeResponse(text=text)


@app.get("/health")
def health():
    return {"status": "ok"}
