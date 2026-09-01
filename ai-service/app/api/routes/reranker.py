import time
from fastapi import APIRouter, HTTPException, status
from app.schemas.reranker import RerankRequest, RerankResponse, RerankerStatusResponse
from app.models.lifecycle import model_lifecycle

router = APIRouter(prefix="/v1/reranker", tags=["Reranker"])

@router.get("/status", response_model=RerankerStatusResponse)
async def get_reranker_status():
    service = model_lifecycle.reranker_service
    if not service:
        return RerankerStatusResponse(
            is_ready=False,
            model_name="none",
            device="cpu"
        )
    return RerankerStatusResponse(
        is_ready=service.is_ready(),
        model_name=getattr(service, "model_name", "bge-reranker-base"),
        device=getattr(service, "device", "cpu")
    )

@router.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    service = model_lifecycle.reranker_service
    if not service or not service.is_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RerankerService is currently uninitialized or unavailable"
        )

    if not req.query or not req.query.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Query string cannot be empty"
        )

    start_t = time.time()
    try:
        results = await service.rerank(
            query=req.query,
            documents=req.documents,
            top_k=req.top_k
        )

        proc_time = round(time.time() - start_t, 4)
        return RerankResponse(
            results=results,
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
            detail=f"Reranking execution failed: {str(e)}"
        )
