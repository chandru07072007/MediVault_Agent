import logging
import sys
import os
from fastapi import APIRouter, Depends, HTTPException, Request
from typing import Any

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents.orchestrator_agent import OrchestratorAgent
from auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["Agent"])
orchestrator = OrchestratorAgent()

@router.post("/agent")
async def run_agent(
    request: Request,
    task: str = None, 
    data: str = None, 
    current_user: str = Depends(get_current_user)
):
    """
    POST endpoint for the multi-agent system.
    Dynamically resolves the 'task' and 'data' arguments from query params or JSON body.
    """
    # 1. Try to read JSON body
    body_data = None
    if request.headers.get("content-type") == "application/json":
        try:
            body_data = await request.json()
        except Exception:
            pass

    # 2. Determine final task and data
    final_task = task
    final_data = data

    if body_data and isinstance(body_data, dict):
        # Case A: JSON body represents the Agent request {"task": "...", "data": ...}
        if "task" in body_data and not final_task:
            final_task = body_data.get("task")
            final_data = body_data.get("data")
        # Case B: task is in query param, data is the entire dictionary payload
        elif final_task and not final_data:
            final_data = body_data
    elif body_data:
        # Case C: task is in query, body is a raw string/array/number
        if final_task and not final_data:
            final_data = body_data

    # If final_data is still None, default to body_data if present
    if final_data is None and body_data is not None:
        final_data = body_data

    if not final_task:
        raise HTTPException(status_code=400, detail="Parameter 'task' is required.")

    logger.info(f"Agent endpoint: task={final_task} user={current_user}")

    # Route task through the Orchestrator
    result = orchestrator.route(final_task, {"data": final_data, "user": current_user})

    if isinstance(result, dict) and result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("message"))

    return result
