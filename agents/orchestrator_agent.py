import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from agents.package_agent import PackageAgent
from agents.report_agent import ReportAgent
from agents.search_agent import SearchAgent
from agents.analytics_agent import AnalyticsAgent
from agents.security_agent import SecurityAgent
from agents.notification_agent import NotificationAgent

logger = logging.getLogger(__name__)

class OrchestratorAgent:
    """Central Orchestrator Agent that routes incoming tasks to dedicated agents."""
    
    def __init__(self):
        self.package_agent = PackageAgent()
        self.report_agent = ReportAgent()
        self.search_agent = SearchAgent()
        self.analytics_agent = AnalyticsAgent()
        self.security_agent = SecurityAgent()
        self.notification_agent = NotificationAgent()

    def route(self, task: str, data: any) -> dict:
        """Route tasks to the appropriate specialized agent based on task type."""
        logger.info(f"Orchestrator routing task={task}")
        
        # User context mapping (if available)
        user_context = None
        payload_data = data
        
        if isinstance(data, dict):
            user_context = data.get("user")
            payload_data = data.get("data", data)

        # Check security authorization first for sensitive operations
        if task in ["upload", "summary", "analytics"]:
            if user_context and not self.security_agent.authorize(user_context):
                logger.warning(f"Unauthorized task attempt: user={user_context} task={task}")
                return {
                    "status": "error",
                    "message": "Security Verification Failed: Unauthorized role."
                }

        try:
            if task == "upload":
                return self.package_agent.create_package(payload_data)
                
            elif task == "summary":
                return self.report_agent.summarize_report(payload_data)
                
            elif task == "search":
                return self.search_agent.search(payload_data)
                
            elif task == "analytics":
                return self.analytics_agent.dashboard()
                
            elif task == "notify":
                return self.notification_agent.send(payload_data)
                
            else:
                logger.warning(f"Unsupported task requested: {task}")
                return {
                    "status": "error",
                    "message": f"Unsupported agent task: {task}"
                }
        except Exception as e:
            logger.exception(f"Error executing agent task={task}")
            return {
                "status": "error",
                "message": f"Agent routing execution failed: {str(e)}"
            }
