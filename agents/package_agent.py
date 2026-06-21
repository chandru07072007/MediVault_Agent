import logging
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import mongodb_tool, gemini_tool

logger = logging.getLogger(__name__)

class PackageAgent:
    """Agent responsible for package creation, metadata saving, and upload status prediction."""
    
    def create_package(self, package_data: dict) -> dict:
        """Create package record, save to MongoDB, and predict upload reliability."""
        logger.info(f"Creating package: {package_data.get('file_name', 'Unnamed')}")
        
        # Determine upload speed / network parameters for predictive analysis
        network_speed = float(package_data.get("network_speed_mb", 5.0))
        total_parts = int(package_data.get("total_parts", 1))
        failed_parts = int(package_data.get("failed_parts", 0))
        
        # Use Gemini Tool to predict failure risk and get network suggestions
        prediction = gemini_tool.predict_upload_failure(network_speed, total_parts, failed_parts)
        
        # Save package to database
        db_payload = {
            "file_name": package_data.get("file_name"),
            "size": package_data.get("size", 0),
            "checksum": package_data.get("checksum"),
            "status": package_data.get("status", "pending"),
            "user_id": package_data.get("user_id", "anonymous"),
            "created_at": package_data.get("created_at"),
            "bucket_name": package_data.get("bucket_name"),
            "upload_id": package_data.get("upload_id"),
            "file_key": package_data.get("file_key"),
            "failure_probability": prediction.get("failure_probability", 0.0),
            "network_health": prediction.get("network_health", "Healthy"),
            "prediction_recommendation": prediction.get("recommendation", "")
        }
        
        db_res = mongodb_tool.save_package(db_payload)
        
        if db_res["status"] == "success":
            return {
                "status": "success",
                "message": "Package uploaded and metadata saved.",
                "package_id": db_res["package"]["_id"],
                "prediction": prediction
            }
        else:
            return {
                "status": "error",
                "message": f"Failed to save package: {db_res.get('message')}"
            }
            
    def update_status(self, package_id: str, status: str) -> dict:
        """Update the status of an existing package."""
        success = mongodb_tool.update_package_status(package_id, status)
        if success:
            return {"status": "success", "message": f"Package status updated to {status}"}
        return {"status": "error", "message": "Failed to update package status"}
