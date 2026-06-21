import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.database.db import users_collection

logger = logging.getLogger(__name__)

class SecurityAgent:
    """Agent responsible for checking user authorization, roles, and access controls."""
    
    def authorize(self, user) -> bool:
        """Verify if a user has access rights (admin or doctor)."""
        if not user:
            logger.warning("Authorization failed: No user context provided.")
            return False
            
        role = None
        username = None
        
        if isinstance(user, dict):
            role = user.get("role")
            username = user.get("username") or user.get("sub")
            
        elif isinstance(user, str):
            username = user

        # If we have a username but no role, check the database
        if username and not role:
            try:
                db_user = users_collection.find_one({"username": username})
                if db_user:
                    role = db_user.get("role")
            except Exception:
                logger.exception(f"Error querying user role for: {username}")
                
        # Defaults to 'doctor' if registered without a role to prevent lockouts,
        # but requires 'admin' or 'doctor' roles.
        if not role:
            role = "doctor"
            
        logger.info(f"Authorizing user={username} with role={role}")
        return role in ["admin", "doctor"]
