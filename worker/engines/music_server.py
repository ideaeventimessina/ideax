"""Start the pinned ACE-Step API with IDEAX's persistent model directory."""

import os
import sys

# IDEAX starts the wrapper with ACE-Step's source directory as the working directory.
sys.path.insert(0, os.getcwd())

from acestep import api_server

project_root = os.environ["ACESTEP_PROJECT_ROOT"]
# The API's download and model-selection paths use this helper directly.
api_server._get_project_root = lambda: project_root
api_server.main()
