import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import mongodb_tool, gemini_tool

logger = logging.getLogger(__name__)

class SearchAgent:
    """Agent responsible for executing natural language search queries against MongoDB."""
    
    def search(self, query: str) -> dict:
        """Parse natural language query into MongoDB filter, execute search, and return results."""
        logger.info(f"Natural language search requested: '{query}'")
        
        query_str = (query or "").strip()
        if not query_str:
            return {"status": "success", "results": []}
            
        # Parse query string into MongoDB filter dictionary using Gemini
        mongo_filter = gemini_tool.parse_natural_language_query(query_str)
        logger.info(f"Mapped query to MongoDB filter: {mongo_filter}")
        
        # Search packages in MongoDB
        results = mongodb_tool.search_packages(mongo_filter)
        
        return {
            "status": "success",
            "query": query,
            "filter_applied": str(mongo_filter),
            "results": results
        }
