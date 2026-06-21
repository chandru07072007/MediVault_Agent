import logging
from bson import ObjectId
import sys
import os

# Ensure the backend directory is in the path to allow imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.database.db import db, packages_collection, uploads_collection, upload_sessions_collection

logger = logging.getLogger(__name__)

def save_package(package_data: dict) -> dict:
    """Save or update package metadata in MongoDB."""
    try:
        if "_id" in package_data:
            pid = package_data["_id"]
            if isinstance(pid, str):
                try:
                    package_data["_id"] = ObjectId(pid)
                except Exception:
                    pass
            
            packages_collection.replace_one({"_id": package_data["_id"]}, package_data, upsert=True)
            package_data["_id"] = str(package_data["_id"])
            return {"status": "success", "package": package_data}
        else:
            result = packages_collection.insert_one(package_data)
            package_data["_id"] = str(result.inserted_id)
            return {"status": "success", "package": package_data}
    except Exception as e:
        logger.exception("Error saving package metadata to MongoDB")
        return {"status": "error", "message": str(e)}

def get_package(package_id: str) -> dict | None:
    """Retrieve package metadata by ID."""
    try:
        query_id = ObjectId(package_id) if isinstance(package_id, str) and len(package_id) == 24 else package_id
        pkg = packages_collection.find_one({"_id": query_id})
        if pkg:
            pkg["_id"] = str(pkg["_id"])
            return pkg
        
        # Fallback to check uploads_collection
        pkg = uploads_collection.find_one({"_id": query_id})
        if pkg:
            pkg["_id"] = str(pkg["_id"])
            if not pkg.get("file_key"):
                # Try to recover file_key and upload_id from the corresponding upload session
                session = upload_sessions_collection.find_one({
                    "user_id": pkg.get("user_id"),
                    "filename": pkg.get("filename"),
                    "size": pkg.get("size")
                })
                if session and session.get("file_key"):
                    pkg["file_key"] = session.get("file_key")
                    pkg["upload_id"] = session.get("upload_id")
            return pkg
            
        return None
    except Exception:
        logger.exception(f"Error fetching package: {package_id}")
        return None

def update_package_status(package_id: str, status: str, summary: str = None, category: str = None) -> bool:
    """Update status, summary, or category of a package."""
    try:
        query_id = ObjectId(package_id) if isinstance(package_id, str) and len(package_id) == 24 else package_id
        update_fields = {"status": status}
        if summary:
            update_fields["summary"] = summary
        if category:
            update_fields["category"] = category

        # Update in packages_collection
        res = packages_collection.update_one({"_id": query_id}, {"$set": update_fields})
        if res.modified_count > 0:
            return True
            
        # Update in uploads_collection (fallback)
        res = uploads_collection.update_one({"_id": query_id}, {"$set": update_fields})
        return res.modified_count > 0
    except Exception:
        logger.exception(f"Error updating package status: {package_id}")
        return False

def delete_package(package_id: str) -> bool:
    """Delete a package from the database."""
    try:
        query_id = ObjectId(package_id) if isinstance(package_id, str) and len(package_id) == 24 else package_id
        res = packages_collection.delete_one({"_id": query_id})
        res_upload = uploads_collection.delete_one({"_id": query_id})
        return res.deleted_count > 0 or res_upload.deleted_count > 0
    except Exception:
        logger.exception(f"Error deleting package: {package_id}")
        return False

def search_packages(filter_dict: dict) -> list:
    """Search for packages using a MongoDB filter dict."""
    try:
        results = []
        for pkg in packages_collection.find(filter_dict):
            pkg["_id"] = str(pkg["_id"])
            results.append(pkg)
        
        # Merge with uploads matching filters if packages are thin
        for upload in uploads_collection.find(filter_dict):
            upload["_id"] = str(upload["_id"])
            # Avoid duplicate key if already present in results
            if not any(x["_id"] == upload["_id"] for x in results):
                results.append(upload)
                
        return results
    except Exception:
        logger.exception("Error searching packages")
        return []

def get_analytics_metrics() -> dict:
    """Fetch package uploads, completed, and pending metrics."""
    try:
        # Sum counts across both collections
        total_p = packages_collection.count_documents({})
        total_u = uploads_collection.count_documents({})
        total_uploads = total_p + total_u

        comp_p = packages_collection.count_documents({"status": "completed"})
        comp_u = uploads_collection.count_documents({"status": "completed"})
        completed = comp_p + comp_u

        pending = total_uploads - completed

        return {
            "uploads": total_uploads,
            "completed": completed,
            "pending": pending
        }
    except Exception:
        logger.exception("Error executing analytics metrics query")
        return {"uploads": 0, "completed": 0, "pending": 0}
