import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import mongodb_tool

logger = logging.getLogger(__name__)

class AnalyticsAgent:
    """Agent responsible for gathering dashboard metrics, upload stats, and analytics trends."""
    
    def dashboard(self) -> dict:
        """Fetch statistics and return structured dashboard analytics."""
        logger.info("Generating dashboard statistics")
        
        # Get metrics counts from MongoDB tool
        metrics = mongodb_tool.get_analytics_metrics()
        
        uploads = metrics.get("uploads", 0)
        completed = metrics.get("completed", 0)
        pending = metrics.get("pending", 0)
        
        # Calculate rates
        success_rate = round((completed / uploads) * 100, 1) if uploads > 0 else 100.0
        
        return {
            "status": "success",
            "uploads": uploads,
            "completed": completed,
            "pending": pending,
            "success_rate": success_rate,
            "trends": {
                "active_users": 1,  # Mock tracking
                "data_transferred_gb": round((completed * 25.0) / 1024, 2)  # Estimation (25MB avg per complete)
            }
        }
