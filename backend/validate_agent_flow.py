import os
import sys

# Ensure backend directory is in the path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["USE_MOCK_S3"] = "true"
os.environ["MONGO_DB_NAME"] = "medivault_test"
os.environ["JWT_SECRET_KEY"] = "test_secret_key_at_least_32_chars_long"

from fastapi.testclient import TestClient
from main import app
from database.db import check_database_connection, packages_collection, uploads_collection, users_collection
from tools import mongodb_tool, s3_tool, pdf_tool, gemini_tool
from agents.orchestrator_agent import OrchestratorAgent

def run_tests():
    print("=== STARTING MEDIPACK AI AGENT FLOW TESTS ===")
    
    # 1. Establish Database Connection
    check_database_connection()
    packages_collection.delete_many({})
    uploads_collection.delete_many({})
    users_collection.delete_many({})
    
    # Register a test doctor user in MongoDB
    users_collection.insert_one({
        "username": "dr_smith",
        "password": "hashed_password_placeholder",
        "role": "doctor"
    })
    
    client = TestClient(app)
    
    # Get auth token
    from auth import create_access_token
    token = create_access_token(data={"sub": "dr_smith"})
    headers = {"Authorization": f"Bearer {token}"}
    
    # Upload some mock content to S3 first to get a valid mock S3 file_key
    print("\n--- Uploading mock PDF to S3 ---")
    s3_res = s3_tool.upload_file(
        "medical-uploads/dr_smith/2026/06/21/mri_brain.pdf", 
        b"Patient name: John Doe. Brain MRI Scan results indicate a normal cerebellar structure. No anomalies found."
    )
    assert s3_res["status"] == "success"
    file_key = s3_res["file_key"]
    print(f"File uploaded to S3 mock path: {file_key}")
    
    # Test 1: Upload Task routing (PackageAgent)
    print("\n--- Testing PackageAgent (Upload Task) ---")
    upload_payload = {
        "file_name": "patient_mri_brain_scan.pdf",
        "size": 15242300,
        "checksum": "sha256_checksum_sample_123",
        "status": "completed",
        "user_id": "dr_smith",
        "bucket_name": "pobo2006",
        "file_key": file_key,
        "network_speed_mb": 0.4  # should trigger low speed prediction recommendation
    }
    
    agent_resp = client.post("/api/agent?task=upload", json=upload_payload, headers=headers)
    assert agent_resp.status_code == 200, f"Failed upload task: {agent_resp.text}"
    upload_data = agent_resp.json()
    print("PackageAgent Response:")
    print(upload_data)
    assert upload_data["status"] == "success"
    package_id = upload_data["package_id"]
    print(f"Package registered with ID: {package_id}")
    
    # Verify in DB
    db_pkg = mongodb_tool.get_package(package_id)
    assert db_pkg is not None
    assert db_pkg["file_name"] == "patient_mri_brain_scan.pdf"
    assert db_pkg["network_health"] == "Critical"
    
    # Test 2: ReportAgent (Summary Task)
    print("\n--- Testing ReportAgent (Summary Task) ---")
    summary_resp = client.post("/api/agent?task=summary", json={"package_id": package_id}, headers=headers)
    assert summary_resp.status_code == 200, f"Failed summary task: {summary_resp.text}"
    summary_data = summary_resp.json()
    print("ReportAgent Response:")
    print(summary_data)
    assert summary_data["status"] == "success"
    assert "cerebellar" in summary_data["summary"].lower() or "brain" in summary_data["summary"].lower()
    
    # Test 3: SearchAgent (Search Task)
    print("\n--- Testing SearchAgent (Search Task) ---")
    search_resp = client.post("/api/agent?task=search", json="completed packages", headers=headers)
    assert search_resp.status_code == 200, f"Failed search task: {search_resp.text}"
    search_data = search_resp.json()
    print("SearchAgent Response:")
    print(f"Found {len(search_data['results'])} matches.")
    assert len(search_data["results"]) >= 1
    
    # Test 4: AnalyticsAgent (Analytics Task)
    print("\n--- Testing AnalyticsAgent (Analytics Task) ---")
    analytics_resp = client.post("/api/agent?task=analytics", headers=headers)
    assert analytics_resp.status_code == 200, f"Failed analytics task: {analytics_resp.text}"
    analytics_data = analytics_resp.json()
    print("AnalyticsAgent Response:")
    print(analytics_data)
    assert analytics_data["uploads"] >= 1
    
    # Test 5: NotificationAgent (Notify Task)
    print("\n--- Testing NotificationAgent (Notify Task) ---")
    notify_resp = client.post("/api/agent?task=notify", json={"email": "doctor@hospital.org", "message": "Brain scan analyzed."}, headers=headers)
    assert notify_resp.status_code == 200, f"Failed notify task: {notify_resp.text}"
    print("NotificationAgent Response:")
    print(notify_resp.json())
    
    print("\n=== ALL MULTI-AGENT E2E FLOW TESTS PASSED! ===")

if __name__ == "__main__":
    run_tests()
