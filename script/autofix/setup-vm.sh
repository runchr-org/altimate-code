#!/bin/bash
# setup-vm.sh — One-time Azure VM provisioning
# Run from your local machine, not the VM.
set -euo pipefail

echo "=== Provisioning ac-autofix-vm ==="

# Generate SSH key if not exists
if [ ! -f ~/.ssh/ac-autofix-vm ]; then
  echo "Generating SSH keypair..."
  ssh-keygen -t ed25519 -f ~/.ssh/ac-autofix-vm -N "" -C "ac-autofix-vm"
fi

# Create VM
echo "Creating Azure VM..."
az vm create \
  --resource-group altimate-code \
  --name ac-autofix-vm \
  --image Ubuntu2404 \
  --size Standard_D16as_v6 \
  --admin-username kulvir \
  --ssh-key-values ~/.ssh/ac-autofix-vm.pub \
  --public-ip-sku Standard \
  --os-disk-size-gb 128 \
  --location eastus \
  --output table

# Open SSH port
echo "Configuring NSG..."
az vm open-port \
  --resource-group altimate-code \
  --name ac-autofix-vm \
  --port 22 \
  --priority 1000 2>/dev/null || true

# Get public IP
VM_IP=$(az vm show \
  --resource-group altimate-code \
  --name ac-autofix-vm \
  -d --query publicIps -o tsv)

echo ""
echo "=== VM Provisioned ==="
echo "IP: $VM_IP"
echo "SSH: ssh -i ~/.ssh/ac-autofix-vm kulvir@$VM_IP"
echo ""
echo "Next: copy bootstrap-vm.sh to the VM and run it:"
echo "  scp -i ~/.ssh/ac-autofix-vm script/autofix/bootstrap-vm.sh kulvir@$VM_IP:~"
echo "  ssh -i ~/.ssh/ac-autofix-vm kulvir@$VM_IP 'bash ~/bootstrap-vm.sh'"
