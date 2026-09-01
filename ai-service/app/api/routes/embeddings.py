import time
from fastapi import APIRouter, HTTPException, status
from app.schemas.embeddings import EmbedRequest, EmbedResponse, EmbeddingStatusResponse
from app.models.lifecycle import model_lifecycle

router = APIRouter(prefix="/v1/embeddings", tags=["Embeddings"])

@router.get("/status", response_model=EmbeddingStatusResponse)
async def get_embedding_status():
    service = model_lifecycle.embedding_service
    if not service:
        return EmbeddingStatusResponse(
            is_ready=False,
            model_name="none",
            dimension=1536,
            device="cpu"
        )
    return EmbeddingStatusResponse(
        is_ready=service.is_ready(),
        model_name=getattr(service, "model_name", "text-embedding-3-small"),
        dimension=getattr(service, "dimension", 1536),
        device=getattr(service, "device", "cpu")
    )

@router.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    service = model_lifecycle.embedding_service
    if not service or not service.is_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="EmbeddingService is currently uninitialized or unavailable"
        )

    if not req.text and not req.texts:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Either 'text' or 'texts' payload must be provided"
        )

    start_t = time.time()
    try:
        single_emb = None
        batch_embs = None

        if req.text is not None:
            single_emb = await service.embed_text(req.text)
        
        if req.texts is not None:
            batch_embs = await service.embed_batch(req.texts)

        proc_time = round(time.time() - start_t, 4)
        dimension = getattr(service, "dimension", 384)

        return EmbedResponse(
            embedding=single_emb,
            embeddings=batch_embs,
            dimension=dimension,
            processing_time=proc_time
        )
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(ve)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Embedding generation failed: {str(e)}"
        )
